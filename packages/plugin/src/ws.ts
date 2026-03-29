import type { ServerMessage } from '@attn/shared/messages'
import { state } from './state.js'
import { decryptMessage, verifyEnvelope } from './crypto.js'
import { saveMessage } from './history.js'

type OnInbound = (from: string, plaintext: string, id: string, ts: number) => void

let reconnectDelay = 1000
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
const keyTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

export function connectToRelay(relayUrl: string, onInbound: OnInbound): void {
  const wsUrl = `${relayUrl}?address=${state.address}`
  process.stderr.write(`attn: connecting to ${relayUrl}\n`)

  const ws = new WebSocket(wsUrl)
  state.ws = ws

  ws.addEventListener('open', () => {
    process.stderr.write(`attn: connected\n`)
  })

  ws.addEventListener('message', async (event) => {
    const msg = JSON.parse(event.data as string) as ServerMessage

    switch (msg.type) {
      case 'challenge': {
        const signature = await state.account!.signMessage({ message: msg.nonce })
        ws.send(JSON.stringify({ type: 'auth', address: state.address, signature }))
        break
      }

      case 'auth_ok':
        state.authenticated = true
        reconnectDelay = 1000
        process.stderr.write(`attn: authenticated as ${msg.address}\n`)
        break

      case 'auth_error':
        process.stderr.write(`attn: auth failed: ${msg.error}\n`)
        break

      case 'message': {
        try {
          // Decrypt
          const plaintext = decryptMessage(state.privateKey, msg.encrypted)

          // Verify signature
          const valid = await verifyEnvelope(
            msg.from,
            { id: msg.id, to: state.address, encrypted: msg.encrypted },
            msg.signature as `0x${string}`,
          )
          if (!valid) {
            process.stderr.write(`attn: invalid signature from ${msg.from}, dropping\n`)
            ws.send(JSON.stringify({ type: 'ack', id: msg.id }))
            break
          }

          // Save to history
          saveMessage({
            id: msg.id,
            peer: msg.from,
            direction: 'inbound',
            content: plaintext,
            ts: new Date(msg.ts).toISOString(),
          })

          // Ack delivery
          ws.send(JSON.stringify({ type: 'ack', id: msg.id }))

          // Notify Claude
          onInbound(msg.from, plaintext, msg.id, msg.ts)
        } catch (err) {
          process.stderr.write(
            `attn: failed to process message from ${msg.from}: ${err instanceof Error ? err.message : err}\n`,
          )
          // Still ack to prevent redelivery of broken messages
          ws.send(JSON.stringify({ type: 'ack', id: msg.id }))
        }
        break
      }

      case 'key_response': {
        const addr = msg.address
        const timeout = keyTimeouts.get(addr)
        if (timeout) {
          clearTimeout(timeout)
          keyTimeouts.delete(addr)
        }
        const callbacks = state.pendingKeyRequests.get(addr)
        if (callbacks) {
          state.pendingKeyRequests.delete(addr)
          if (msg.publicKey) state.keyCache.set(addr, msg.publicKey)
          for (const cb of callbacks) cb(msg.publicKey)
        }
        break
      }

      case 'received':
      case 'delivered':
        // Could log or resolve pending promises, silent for now
        break

      case 'error':
        process.stderr.write(`attn: relay error: ${msg.error}\n`)
        break
    }
  })

  ws.addEventListener('close', () => {
    state.authenticated = false
    state.ws = null
    if (reconnectTimer) clearTimeout(reconnectTimer)
    process.stderr.write(`attn: disconnected, reconnecting in ${reconnectDelay}ms\n`)
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 30000)
      connectToRelay(relayUrl, onInbound)
    }, reconnectDelay)
  })

  ws.addEventListener('error', () => {
    // close event will fire after this, handling reconnect
  })
}

export function requestKey(address: string): Promise<string | null> {
  const cached = state.keyCache.get(address.toLowerCase())
  if (cached) return Promise.resolve(cached)

  return new Promise((resolve) => {
    const addr = address.toLowerCase()
    const existing = state.pendingKeyRequests.get(addr) ?? []
    existing.push(resolve)
    state.pendingKeyRequests.set(addr, existing)

    if (existing.length === 1 && state.ws) {
      state.ws.send(JSON.stringify({ type: 'get_key', address: addr }))

      // Single timeout per address
      const timeout = setTimeout(() => {
        keyTimeouts.delete(addr)
        const cbs = state.pendingKeyRequests.get(addr)
        if (cbs) {
          state.pendingKeyRequests.delete(addr)
          for (const cb of cbs) cb(null)
        }
      }, 10000)
      keyTimeouts.set(addr, timeout)
    }
  })
}

export function cleanup(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (state.ws) {
    try { state.ws.close() } catch {}
  }
}
