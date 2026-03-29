import { DurableObject } from 'cloudflare:workers'
import { verifyAuth } from './auth.js'

type Env = {
  AGENT_MAILBOX: DurableObjectNamespace
}

type WsAttachment = {
  nonce: string
  authenticated: boolean
  address?: string
  expectedAddress?: string
}

function isValidAddress(addr: unknown): addr is string {
  return typeof addr === 'string' && /^0x[0-9a-fA-F]{40}$/.test(addr)
}

export class AgentMailbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS public_keys (
          address TEXT PRIMARY KEY,
          public_key TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS queue (
          id TEXT PRIMARY KEY,
          from_address TEXT NOT NULL,
          encrypted TEXT NOT NULL,
          signature TEXT NOT NULL,
          ts INTEGER NOT NULL,
          delivered INTEGER NOT NULL DEFAULT 0
        )
      `)
    })
  }

  async fetch(request: Request): Promise<Response> {
    // Probabilistic TTL cleanup (5% chance per request)
    if (Math.random() < 0.05) {
      const alarm = await this.ctx.storage.getAlarm()
      if (!alarm) await this.ctx.storage.setAlarm(Date.now() + 60_000)
    }

    const url = new URL(request.url)

    // Internal: deliver a message to this agent's mailbox (only callable from other DOs)
    if (request.method === 'POST' && url.pathname === '/deliver') {
      if (url.hostname !== 'internal') {
        return Response.json({ error: 'Forbidden' }, { status: 403 })
      }
      const msg = (await request.json()) as {
        id: string
        from: string
        encrypted: string
        signature: string
        ts: number
      }

      // Store in queue
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO queue (id, from_address, encrypted, signature, ts, delivered) VALUES (?, ?, ?, ?, ?, 0)`,
        msg.id,
        msg.from,
        msg.encrypted,
        msg.signature,
        msg.ts,
      )

      // Try to deliver to connected sockets
      const sockets = this.ctx.getWebSockets()
      let delivered = false

      for (const ws of sockets) {
        const att = ws.deserializeAttachment() as WsAttachment | null
        if (att?.authenticated) {
          try {
            ws.send(
              JSON.stringify({
                type: 'message',
                id: msg.id,
                from: msg.from,
                encrypted: msg.encrypted,
                signature: msg.signature,
                ts: msg.ts,
              }),
            )
            delivered = true
          } catch {}
        }
      }

      if (delivered) {
        this.ctx.storage.sql.exec(`UPDATE queue SET delivered = 1 WHERE id = ?`, msg.id)
      }

      return Response.json({ status: delivered ? 'delivered' : 'queued' })
    }

    // Internal: get this agent's public key
    if (request.method === 'GET' && url.pathname === '/key') {
      const rows = [
        ...this.ctx.storage.sql.exec<{ public_key: string }>(
          `SELECT public_key FROM public_keys LIMIT 1`,
        ),
      ]
      if (rows.length === 0) {
        return Response.json({ publicKey: null }, { status: 404 })
      }
      return Response.json({ publicKey: rows[0].public_key })
    }

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)

      const expectedAddress = new URL(request.url).searchParams.get('address')?.toLowerCase()
      const nonce = crypto.randomUUID() + '-' + Date.now().toString(36)
      this.ctx.acceptWebSocket(server)

      server.serializeAttachment({ nonce, authenticated: false, expectedAddress } satisfies WsAttachment)
      server.send(JSON.stringify({ type: 'challenge', nonce }))

      return new Response(null, { status: 101, webSocket: client })
    }

    return Response.json({ error: 'Bad request' }, { status: 400 })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return

    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(message)
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }))
      return
    }

    const att = ws.deserializeAttachment() as WsAttachment | null
    if (!att) return

    // Unauthenticated: only accept auth messages
    if (!att.authenticated) {
      if (msg.type !== 'auth') {
        ws.send(JSON.stringify({ type: 'error', error: 'Not authenticated' }))
        return
      }

      const address = msg.address as string
      const signature = msg.signature as `0x${string}`

      // Verify claimed address matches the DO's expected address
      if (att.expectedAddress && address.toLowerCase() !== att.expectedAddress) {
        ws.send(JSON.stringify({ type: 'auth_error', error: 'Address does not match this mailbox' }))
        ws.close(4001, 'Auth failed')
        return
      }

      const result = await verifyAuth(att.nonce, address, signature)
      if (!result.valid) {
        ws.send(JSON.stringify({ type: 'auth_error', error: result.reason }))
        ws.close(4001, 'Auth failed')
        return
      }

      // Store public key permanently
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO public_keys (address, public_key, updated_at) VALUES (?, ?, ?)`,
        address.toLowerCase(),
        result.publicKey!,
        Date.now(),
      )

      // Mark authenticated
      ws.serializeAttachment({
        nonce: att.nonce,
        authenticated: true,
        address: address.toLowerCase(),
      } satisfies WsAttachment)

      ws.send(JSON.stringify({ type: 'auth_ok', address: address.toLowerCase() }))

      // Flush queued messages
      const queued = [
        ...this.ctx.storage.sql.exec<{
          id: string
          from_address: string
          encrypted: string
          signature: string
          ts: number
        }>(`SELECT id, from_address, encrypted, signature, ts FROM queue WHERE delivered = 0 ORDER BY ts ASC LIMIT 100`),
      ]

      const deliveredIds: string[] = []
      for (const row of queued) {
        try {
          ws.send(
            JSON.stringify({
              type: 'message',
              id: row.id,
              from: row.from_address,
              encrypted: row.encrypted,
              signature: row.signature,
              ts: row.ts,
            }),
          )
          deliveredIds.push(row.id)
        } catch {
          break
        }
      }
      if (deliveredIds.length > 0) {
        const placeholders = deliveredIds.map(() => '?').join(',')
        this.ctx.storage.sql.exec(
          `UPDATE queue SET delivered = 1 WHERE id IN (${placeholders})`,
          ...deliveredIds,
        )
      }
      return
    }

    // Authenticated: handle messages
    switch (msg.type) {
      case 'message': {
        const to = msg.to as string
        const id = msg.id as string
        const encrypted = msg.encrypted as string
        const signature = msg.signature as string

        if (!isValidAddress(to)) {
          ws.send(JSON.stringify({ type: 'error', error: 'Invalid recipient address' }))
          break
        }
        if (!id || typeof id !== 'string' || id.length > 100) {
          ws.send(JSON.stringify({ type: 'error', error: 'Invalid message id' }))
          break
        }
        if (!encrypted || typeof encrypted !== 'string') {
          ws.send(JSON.stringify({ type: 'error', error: 'Missing encrypted content' }))
          break
        }

        // ACK receipt
        ws.send(JSON.stringify({ type: 'received', id }))

        // Route to recipient's DO
        const recipientId = this.env.AGENT_MAILBOX.idFromName(to.toLowerCase())
        const recipientStub = this.env.AGENT_MAILBOX.get(recipientId)

        try {
          const resp = await recipientStub.fetch(
            new Request('https://internal/deliver', {
              method: 'POST',
              body: JSON.stringify({
                id,
                from: att.address,
                encrypted,
                signature,
                ts: Date.now(),
              }),
            }),
          )

          const result = (await resp.json()) as { status: string }
          if (result.status === 'delivered') {
            ws.send(JSON.stringify({ type: 'delivered', id }))
          }
        } catch (err) {
          ws.send(
            JSON.stringify({
              type: 'error',
              error: `Failed to route message: ${err instanceof Error ? err.message : 'unknown'}`,
            }),
          )
        }
        break
      }

      case 'ack': {
        const messageId = msg.id as string
        this.ctx.storage.sql.exec(`DELETE FROM queue WHERE id = ?`, messageId)
        // Schedule cleanup since delivered messages were just modified
        const alarm = await this.ctx.storage.getAlarm()
        if (!alarm) await this.ctx.storage.setAlarm(Date.now() + 60_000)
        break
      }

      case 'get_key': {
        if (!isValidAddress(msg.address)) {
          ws.send(JSON.stringify({ type: 'error', error: 'Invalid address' }))
          break
        }
        const targetAddress = (msg.address as string).toLowerCase()
        const targetId = this.env.AGENT_MAILBOX.idFromName(targetAddress)
        const targetStub = this.env.AGENT_MAILBOX.get(targetId)

        try {
          const resp = await targetStub.fetch(
            new Request(`https://internal/key`),
          )
          const result = (await resp.json()) as { publicKey: string | null }
          ws.send(
            JSON.stringify({
              type: 'key_response',
              address: targetAddress,
              publicKey: result.publicKey,
            }),
          )
        } catch {
          ws.send(
            JSON.stringify({
              type: 'key_response',
              address: targetAddress,
              publicKey: null,
            }),
          )
        }
        break
      }

      default:
        ws.send(JSON.stringify({ type: 'error', error: `Unknown message type: ${msg.type}` }))
    }
  }

  async alarm(): Promise<void> {
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000
    const now = Date.now()
    this.ctx.storage.sql.exec(`DELETE FROM queue WHERE ts < ? AND delivered = 1`, now - SEVEN_DAYS)
    this.ctx.storage.sql.exec(`DELETE FROM queue WHERE ts < ?`, now - THIRTY_DAYS)
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason)
    } catch {}
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, 'WebSocket error')
    } catch {}
  }
}
