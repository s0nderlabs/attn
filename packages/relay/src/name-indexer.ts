import { DurableObject } from 'cloudflare:workers'
import { decodeAbiParameters, encodeFunctionData, decodeFunctionResult, keccak256, toHex } from 'viem'

// Minimal ABI for on-chain fallback calls (resolve + namehash only)
const resolveAbi = [
  { type: 'function', name: 'resolve', inputs: [{ name: 'label', type: 'string' }], outputs: [{ name: 'owner_', type: 'address' }, { name: 'node', type: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'namehash', inputs: [{ name: 'label', type: 'string' }], outputs: [{ name: '', type: 'bytes32' }], stateMutability: 'pure' },
  { type: 'function', name: 'primaryNameOf', inputs: [{ name: 'addr', type: 'address' }], outputs: [{ name: '', type: 'string' }], stateMutability: 'view' },
] as const

type Env = {
  AGENT_MAILBOX: DurableObjectNamespace
  NAME_INDEXER: DurableObjectNamespace
  BASE_WSS_RPC: string
  BASE_HTTP_RPC: string
}

const CONTRACT_ADDRESS = '0x5caDD2F7d8fC6B35bb220cC3DB8DBc187E02dC7A'
const ALARM_INTERVAL_MS = 30_000
const PRIMARY_CACHE_TTL_MS = 5 * 60 * 1000 // 5 min — cosmetic display, safe to cache
const DEPLOY_BLOCK = 44327000

// Event topics
const NAME_REGISTERED_TOPIC = keccak256(toHex('NameRegistered(bytes32,string,address,uint256)'))
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

export class NameIndexer extends DurableObject<Env> {
  private ws: WebSocket | null = null
  private wsConnected = false
  private primaryCache = new Map<string, { name: string | null; ts: number }>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS names (
          label TEXT PRIMARY KEY,
          address TEXT NOT NULL,
          token_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS sync_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `)
      try {
        this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_names_address ON names(address)`)
      } catch {}

      // Schedule alarm if none exists
      const alarm = await this.ctx.storage.getAlarm()
      if (!alarm) {
        await this.ctx.storage.setAlarm(Date.now() + 1000)
      }
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/resolve') {
      const name = url.searchParams.get('name')?.toLowerCase()
      if (!name) return Response.json({ address: null })

      // Always resolve on-chain — names can transfer at any time, stale cache = wrong recipient
      const address = await this.resolveOnChain(name)
      if (address) {
        const tokenId = await this.getTokenId(name)
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO names (label, address, token_id, updated_at) VALUES (?, ?, ?, ?)`,
          name, address, tokenId ?? '', Date.now()
        )
      }
      return Response.json({ address })
    }

    if (url.pathname === '/names') {
      const address = url.searchParams.get('address')?.toLowerCase()
      if (!address) return Response.json({ names: [] })

      const rows = [...this.ctx.storage.sql.exec<{ label: string }>(
        `SELECT label FROM names WHERE lower(address) = ? ORDER BY label`, address
      )]
      return Response.json({ names: rows.map(r => r.label) })
    }

    if (url.pathname === '/primary') {
      const address = url.searchParams.get('address')?.toLowerCase()
      if (!address) return Response.json({ name: null })

      // Check in-memory cache (5 min TTL — cosmetic, safe to cache)
      const cached = this.primaryCache.get(address)
      if (cached && Date.now() - cached.ts < PRIMARY_CACHE_TTL_MS) {
        return Response.json({ name: cached.name })
      }

      // 1. Check on-chain primary name
      let result: string | null = null
      const primary = await this.primaryNameOnChain(address)
      if (primary) {
        result = primary + '.attn'
      } else {
        // 2. Fallback: pick any name they own from SQLite cache
        const owned = [...this.ctx.storage.sql.exec<{ label: string }>(
          `SELECT label FROM names WHERE lower(address) = ? LIMIT 1`, address
        )]
        if (owned.length > 0) result = owned[0].label + '.attn'
      }

      this.primaryCache.set(address, { name: result, ts: Date.now() })
      return Response.json({ name: result })
    }

    if (url.pathname === '/sync' && request.method === 'POST') {
      await this.pollLogs()
      return Response.json({ synced: true })
    }

    return new Response('Not found', { status: 404 })
  }

  async alarm(): Promise<void> {
    // Ensure WSS subscription is alive
    if (!this.wsConnected) {
      await this.connectWss()
    }

    // Also do an eth_getLogs poll to catch any missed events
    try {
      await this.pollLogs()
    } catch {}

    // Reschedule alarm
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS)
  }

  private async connectWss(): Promise<void> {
    if (!this.env.BASE_WSS_RPC) {
      // No WSS configured — rely on polling only
      return
    }

    try {
      // Close existing connection if any
      if (this.ws) {
        try { this.ws.close() } catch {}
        this.ws = null
      }

      const resp = await fetch(this.env.BASE_WSS_RPC, {
        headers: { Upgrade: 'websocket' },
      })

      const ws = resp.webSocket
      if (!ws) return

      ws.accept()
      this.ws = ws
      this.wsConnected = true

      // Subscribe to NameRegistered + Transfer events
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_subscribe',
        params: ['logs', {
          address: CONTRACT_ADDRESS,
          topics: [[NAME_REGISTERED_TOPIC, TRANSFER_TOPIC]],
        }],
      }))

      ws.addEventListener('message', (event) => {
        try {
          const data = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer))
          if (data.method === 'eth_subscription' && data.params?.result) {
            this.handleLog(data.params.result)
          }
        } catch {}
      })

      ws.addEventListener('close', () => {
        this.wsConnected = false
        this.ws = null
      })

      ws.addEventListener('error', () => {
        this.wsConnected = false
        try { this.ws?.close() } catch {}
        this.ws = null
      })
    } catch {
      this.wsConnected = false
      this.ws = null
    }
  }

  private handleLog(log: { topics: string[]; data: string; blockNumber: string }): void {
    const topic0 = log.topics[0]

    if (topic0 === NAME_REGISTERED_TOPIC) {
      // NameRegistered(bytes32 indexed node, string label, address indexed owner, uint256 tokenId)
      // topics[1] = node, topics[2] = owner (padded)
      const owner = ('0x' + log.topics[2].slice(26)).toLowerCase()
      // Decode non-indexed params: (string label, uint256 tokenId)
      const decoded = decodeAbiParameters(
        [{ name: 'label', type: 'string' }, { name: 'tokenId', type: 'uint256' }],
        log.data as `0x${string}`
      )
      const label = (decoded[0] as string).toLowerCase()
      const tokenId = (decoded[1] as bigint).toString()

      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO names (label, address, token_id, updated_at) VALUES (?, ?, ?, ?)`,
        label, owner, tokenId, Date.now()
      )
    } else if (topic0 === TRANSFER_TOPIC) {
      // Transfer(address indexed from, address indexed to, uint256 indexed tokenId)
      const to = ('0x' + log.topics[2].slice(26)).toLowerCase()
      const tokenId = BigInt(log.topics[3]).toString()

      if (to === '0x0000000000000000000000000000000000000000') {
        // Burn — delete name
        this.ctx.storage.sql.exec(`DELETE FROM names WHERE token_id = ?`, tokenId)
      } else {
        // Transfer — update owner
        this.ctx.storage.sql.exec(
          `UPDATE names SET address = ?, updated_at = ? WHERE token_id = ?`,
          to, Date.now(), tokenId
        )
      }
    }

    // Update last synced block
    const blockNum = parseInt(log.blockNumber, 16)
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO sync_state (key, value) VALUES ('last_block', ?)`,
      blockNum.toString()
    )
  }

  private async pollLogs(): Promise<void> {
    const rows = [...this.ctx.storage.sql.exec<{ value: string }>(
      `SELECT value FROM sync_state WHERE key = 'last_block'`
    )]
    const fromBlock = rows.length > 0 ? parseInt(rows[0].value) + 1 : DEPLOY_BLOCK

    const body = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
      params: [{
        address: CONTRACT_ADDRESS,
        fromBlock: '0x' + fromBlock.toString(16),
        toBlock: 'latest',
        topics: [[NAME_REGISTERED_TOPIC, TRANSFER_TOPIC]],
      }],
    })

    const resp = await fetch(this.env.BASE_HTTP_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    const result = (await resp.json()) as { result?: Array<{ topics: string[]; data: string; blockNumber: string }> }

    if (result.result) {
      for (const log of result.result) {
        this.handleLog(log)
      }
    }
  }

  private async resolveOnChain(label: string): Promise<string | null> {
    const calldata = encodeFunctionData({
      abi: resolveAbi,
      functionName: 'resolve',
      args: [label],
    })

    const resp = await fetch(this.env.BASE_HTTP_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: CONTRACT_ADDRESS, data: calldata }, 'latest'],
      }),
    })
    const result = (await resp.json()) as { result?: string }
    if (!result.result || result.result === '0x') return null

    const decoded = decodeFunctionResult({
      abi: resolveAbi,
      functionName: 'resolve',
      data: result.result as `0x${string}`,
    })
    const address = (decoded as [string, string])[0]
    if (address === '0x0000000000000000000000000000000000000000') return null
    return address.toLowerCase()
  }

  private async getTokenId(label: string): Promise<string | null> {
    const calldata = encodeFunctionData({
      abi: resolveAbi,
      functionName: 'namehash',
      args: [label],
    })

    const resp = await fetch(this.env.BASE_HTTP_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: CONTRACT_ADDRESS, data: calldata }, 'latest'],
      }),
    })
    const result = (await resp.json()) as { result?: string }
    if (!result.result) return null
    return BigInt(result.result).toString()
  }

  private async primaryNameOnChain(address: string): Promise<string | null> {
    const calldata = encodeFunctionData({
      abi: resolveAbi,
      functionName: 'primaryNameOf',
      args: [address as `0x${string}`],
    })

    const resp = await fetch(this.env.BASE_HTTP_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: CONTRACT_ADDRESS, data: calldata }, 'latest'],
      }),
    })
    const result = (await resp.json()) as { result?: string }
    if (!result.result || result.result === '0x' || result.result.length <= 66) return null

    const decoded = decodeFunctionResult({
      abi: resolveAbi,
      functionName: 'primaryNameOf',
      data: result.result as `0x${string}`,
    })
    const name = decoded as string
    return name || null
  }
}
