import type { ServerMessage } from '@attn/shared/messages'
import { join } from 'path'
import { state } from './state.js'
import { writeStatusFile, isRelayReady, getSessionType, getRelayStatus } from './status.js'
import { decryptMessage, decryptBinary, verifyEnvelope } from './crypto.js'
import {
  saveMessage,
  isContact,
  isBlocked,
  getContactName,
  savePending,
  hasPendingNotified,
  markPendingNotified,
  getOutbox,
  deleteOutbox,
  incrementOutboxAttempts,
  saveKeyCache,
  getKeyCache,
  saveGroupInvite,
  addGroupMember,
  removeGroupMember,
  saveReaction,
  updateContactName,
} from './history.js'
import { getInboxDir, loadPresence, savePresence } from './env.js'
import type { PresenceState } from './state.js'

type OnInbound = (
  from: string, plaintext: string, id: string, ts: number,
  trust?: string, agentName?: string, groupId?: string, groupName?: string,
  reactionMessageId?: string,
) => void

let reconnectDelay = 1000
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let pingInterval: ReturnType<typeof setInterval> | null = null
let authHandshakeTimer: ReturnType<typeof setTimeout> | null = null
let healthWatchdogTimer: ReturnType<typeof setInterval> | null = null
let lastHealthyAt = Date.now()
// Captured on the first connectToRelay call so module-level recovery paths
// (health watchdog, scheduleReconnect, forceCleanupAndReconnect) can re-enter
// the connect flow without needing them passed in.
let currentRelayUrl: string | null = null
let currentOnInbound: OnInbound | null = null
const keyTimeouts = new Map<string, ReturnType<typeof setTimeout>>()
const resolveTimeouts = new Map<string, ReturnType<typeof setTimeout>>()
const presenceTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

const AWAY_SUMMARY_WINDOW_MS = 3_000
const AWAY_NOTICE_DEDUPE_MS = 5 * 60_000
const PRESENCE_QUERY_TIMEOUT_MS = 5_000
const AWAY_NOTICES_CAP = 500

let awayNotifier: ((to: string, message: string | null) => void) | null = null
export function setAwayNotifier(fn: (to: string, message: string | null) => void): void {
  awayNotifier = fn
}

let awaySummaryNotifier: ((count: number) => void) | null = null
export function setAwaySummaryNotifier(fn: (count: number) => void): void {
  awaySummaryNotifier = fn
}

// Force a reconnect by closing the current socket. Use for OPEN-state sockets
// where ws.close() reliably emits a close event (pong watchdog, challenge
// handler error, auth_error). For CONNECTING sockets, use forceCleanupAndReconnect
// — Bun does NOT reliably fire close on a CONNECTING socket, so the close
// handler cascade never runs and the reconnect loop wedges.
function forceReconnect(ws: WebSocket, reason: string): void {
  process.stderr.write(`attn: forcing reconnect — ${reason}\n`)
  try { ws.close(4000, reason) } catch {}
}

// Tear down all per-ws state. Called from both the close handler (after an
// actual close event) and forceCleanupAndReconnect (when we can't wait for
// one). Must be idempotent — both paths may fire for the same ws.
function teardownWsState(): void {
  state.authenticated = false
  state.ws = null
  if (pingInterval) { clearInterval(pingInterval); pingInterval = null }
  if (authHandshakeTimer) { clearTimeout(authHandshakeTimer); authHandshakeTimer = null }
}

// Aggressive recovery for cases where we can't trust the close event to
// follow ws.close(). Best-effort closes the current ws, tears down state,
// writes the status file, schedules the next reconnect.
function forceCleanupAndReconnect(reason: string): void {
  process.stderr.write(`attn: force cleanup + reconnect — ${reason}\n`)
  if (state.ws) {
    try { state.ws.close() } catch {}
  }
  teardownWsState()
  writeStatusFile()
  scheduleReconnect()
}

// Arm the reconnect timer. Idempotent — clears any existing pending timer
// before scheduling a new one. Wraps the setTimeout callback in try/catch so
// a synchronous throw inside `new WebSocket(...)` or connectToRelay can never
// kill the reconnect loop permanently.
function scheduleReconnect(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  process.stderr.write(`attn: reconnect scheduled in ${reconnectDelay}ms\n`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    try {
      reconnectDelay = Math.min(reconnectDelay * 2, 30000)
      if (currentRelayUrl && currentOnInbound) {
        connectToRelay(currentRelayUrl, currentOnInbound)
      } else {
        process.stderr.write(`attn: reconnect skipped — no relayUrl captured\n`)
      }
    } catch (err) {
      process.stderr.write(`attn: reconnect attempt threw: ${err instanceof Error ? err.message : err}\n`)
      // Re-arm on the next backoff interval so a sync throw doesn't end the loop
      scheduleReconnect()
    }
  }, reconnectDelay)
}

// Sync local contact name with relay-provided .attn name (always fresh, on-chain)
function syncContactName(address: string, relayName?: string): string | null {
  const local = getContactName(address)
  if (relayName && relayName !== local) updateContactName(address, relayName)
  else if (!relayName && local?.endsWith('.attn')) updateContactName(address, null)
  return relayName ?? (local?.endsWith('.attn') ? null : local)
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function connectToRelay(relayUrl: string, onInbound: OnInbound): void {
  // Capture for module-level recovery paths (health watchdog, scheduleReconnect)
  currentRelayUrl = relayUrl
  currentOnInbound = onInbound

  const wsUrl = `${relayUrl}?address=${state.address}`
  process.stderr.write(`attn: connecting to ${relayUrl}\n`)

  const ws = new WebSocket(wsUrl)
  state.ws = ws
  writeStatusFile()

  // Handshake watchdog — if auth_ok doesn't arrive within 10s, force cleanup
  // and reconnect. Covers slow DO cold starts, lost challenge/auth frames.
  // Uses forceCleanupAndReconnect (not forceReconnect) because the ws is
  // typically still in CONNECTING state here — see forceReconnect() docs.
  if (authHandshakeTimer) clearTimeout(authHandshakeTimer)
  authHandshakeTimer = setTimeout(() => {
    if (state.ws === ws && !state.authenticated) {
      forceCleanupAndReconnect(`auth handshake timeout (10s, readyState=${ws.readyState})`)
    }
  }, 10_000)

  ws.addEventListener('open', () => {
    process.stderr.write(`attn: connected\n`)
    writeStatusFile()
  })

  ws.addEventListener('message', async (event) => {
    const raw = event.data as string
    if (raw === 'pong') {
      state.lastPongAt = Date.now()
      return
    }

    const msg = JSON.parse(raw) as ServerMessage

    switch (msg.type) {
      case 'challenge': {
        try {
          const signature = await state.account!.signMessage({ message: msg.nonce })
          if (ws.readyState === WebSocket.OPEN) {
            // Include persisted presence in the auth payload so the relay can
            // commit our state atomically before deciding whether to flush
            // the queue. A v0.6.0 server just ignores unknown fields.
            ws.send(JSON.stringify({
              type: 'auth',
              address: state.address,
              signature,
              presence: state.presence,
              presence_message: state.presenceMessage,
            }))
          } else {
            forceReconnect(ws, `socket closed during challenge signing (state ${ws.readyState})`)
          }
        } catch (err) {
          forceReconnect(ws, `challenge handler error: ${err instanceof Error ? err.message : err}`)
        }
        break
      }

      case 'auth_ok':
        state.authenticated = true
        state.lastPongAt = Date.now()
        reconnectDelay = 1000
        process.stderr.write(`attn: authenticated as ${msg.address}\n`)
        if (authHandshakeTimer) { clearTimeout(authHandshakeTimer); authHandshakeTimer = null }
        writeStatusFile()
        if (pingInterval) clearInterval(pingInterval)
        pingInterval = setInterval(() => {
          // Pong watchdog: if 90s since last pong (3 missed), the socket is
          // dead even if readyState still says OPEN. Force a reconnect.
          if (Date.now() - state.lastPongAt > 90_000) {
            process.stderr.write(
              `attn: pong watchdog expired — ${Math.floor((Date.now() - state.lastPongAt) / 1000)}s since last pong\n`,
            )
            forceReconnect(ws, 'pong watchdog')
            return
          }
          if (ws.readyState !== WebSocket.OPEN) {
            forceReconnect(ws, `ping on non-open socket (state ${ws.readyState})`)
            return
          }
          try { ws.send('ping') } catch (err) {
            process.stderr.write(`attn: ping send failed: ${err instanceof Error ? err.message : err}\n`)
            forceReconnect(ws, 'ping send threw')
          }
        }, 30_000)
        flushOutbox(ws)
        // Re-assert persisted presence after auth. Relay state resets per-DO
        // on cold start, so we always resync on connect.
        try {
          const persisted = loadPresence()
          if (persisted) {
            state.presence = persisted.state
            state.presenceMessage = persisted.message
          }
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'presence_set',
              state: state.presence,
              message: state.presenceMessage,
            }))
          }
        } catch (err) {
          process.stderr.write(`attn: presence re-assert failed: ${err instanceof Error ? err.message : err}\n`)
        }
        break

      case 'auth_error':
        process.stderr.write(`attn: auth failed: ${msg.error}\n`)
        forceReconnect(ws, `auth_error: ${msg.error}`)
        break

      case 'message': {
        try {
          // Blocked? silently drop (before any processing)
          if (isBlocked(msg.from)) {
            ws.send(JSON.stringify({ type: 'ack', id: msg.id }))
            break
          }

          // Group invite — sent as unencrypted JSON, try to parse before decrypting
          // Group system messages (unencrypted JSON from relay)
          if (msg.group_id && msg.encrypted.startsWith('{')) {
            try {
              const sysMsg = JSON.parse(msg.encrypted) as { type: string; [key: string]: unknown }

              if (sysMsg.type === 'group_invite') {
                const invite = sysMsg as {
                  type: string; group_id: string; group_name: string; from: string; members: string[]
                }
                saveGroupInvite({
                  group_id: invite.group_id,
                  group_name: invite.group_name,
                  from_address: invite.from,
                  members: invite.members,
                  ts: msg.ts,
                })
                ws.send(JSON.stringify({ type: 'ack', id: msg.id }))
                const fromName = getContactName(invite.from)
                onInbound(
                  invite.from,
                  `[Group Invite] ${fromName || invite.from} invited you to "${invite.group_name}" (${invite.members.length} members). Ask your user to accept or decline.`,
                  msg.id, msg.ts, 'group_invite', fromName ?? undefined,
                  invite.group_id, invite.group_name,
                )
                break
              }

              if (sysMsg.type === 'group_member_update') {
                const update = sysMsg as {
                  type: string; group_id: string; group_name: string; action: string; address: string; members: string[]
                }
                // Sync local member list
                if (update.action === 'joined') {
                  addGroupMember(update.group_id, update.address)
                } else if (update.action === 'left') {
                  removeGroupMember(update.group_id, update.address)
                }
                ws.send(JSON.stringify({ type: 'ack', id: msg.id }))
                const fromName = getContactName(update.address)
                const actionText = update.action === 'joined' ? 'joined'
                  : update.action === 'admin_transferred' ? 'is now admin of'
                  : 'left'
                onInbound(
                  update.address,
                  `[Group] ${fromName || update.address} ${actionText} "${update.group_name}"`,
                  msg.id, msg.ts, undefined, undefined,
                  update.group_id, update.group_name,
                )
                break
              }
            } catch {}
          }

          // Decrypt the message (for non-invite messages)
          const plaintext = decryptMessage(state.privateKey, msg.encrypted)

          // Group message — skip signature verification (relay is trust anchor for groups)
          if (msg.group_id) {
            const agentName = syncContactName(msg.from, msg.from_name)
            const { displayContent } = await processFileRef(plaintext)

            saveMessage({
              id: msg.id,
              peer: msg.group_id,
              direction: 'inbound',
              content: displayContent,
              ts: new Date(msg.ts).toISOString(),
            })
            ws.send(JSON.stringify({ type: 'ack', id: msg.id }))
            onInbound(msg.from, displayContent, msg.id, msg.ts, undefined, agentName ?? undefined, msg.group_id, msg.group_name)
            break
          }

          // Direct message — verify signature
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

          // Unknown sender? → pending
          if (!isContact(msg.from)) {
            savePending({ id: msg.id, from_address: msg.from, plaintext, ts: msg.ts })
            ws.send(JSON.stringify({ type: 'ack', id: msg.id }))

            if (!hasPendingNotified(msg.from)) {
              markPendingNotified(msg.from)
              const relayName = (msg as any).from_name as string | undefined
              const pendingContent = relayName
                ? `pending message from ${relayName}`
                : `pending message from unknown agent`
              onInbound(
                msg.from,
                pendingContent,
                msg.id,
                msg.ts,
                'pending',
                relayName,
              )
            }
            break
          }

          // Known contact — deliver
          const agentName = syncContactName(msg.from, msg.from_name)
          const { displayContent } = await processFileRef(plaintext)

          saveMessage({
            id: msg.id,
            peer: msg.from,
            direction: 'inbound',
            content: displayContent,
            ts: new Date(msg.ts).toISOString(),
          })

          ws.send(JSON.stringify({ type: 'ack', id: msg.id }))
          onInbound(msg.from, displayContent, msg.id, msg.ts, undefined, agentName ?? undefined)
        } catch (err) {
          process.stderr.write(
            `attn: failed to process message from ${msg.from}: ${err instanceof Error ? err.message : err}\n`,
          )
          ws.send(JSON.stringify({ type: 'ack', id: msg.id }))
        }
        break
      }

      case 'reaction': {
        try {
          if (isBlocked(msg.from)) {
            ws.send(JSON.stringify({ type: 'ack', id: msg.id }))
            break
          }

          const emoji = decryptMessage(state.privateKey, msg.encrypted)

          // DM reactions: verify signature
          if (!msg.group_id) {
            const valid = await verifyEnvelope(
              msg.from,
              { id: msg.id, to: state.address, encrypted: msg.encrypted },
              msg.signature as `0x${string}`,
            )
            if (!valid) {
              ws.send(JSON.stringify({ type: 'ack', id: msg.id }))
              break
            }

            // Silently drop reactions from non-contacts
            if (!isContact(msg.from)) {
              ws.send(JSON.stringify({ type: 'ack', id: msg.id }))
              break
            }
          }

          saveReaction({
            message_id: msg.message_id,
            from_address: msg.from,
            emoji,
            ts: new Date(msg.ts).toISOString(),
          })

          ws.send(JSON.stringify({ type: 'ack', id: msg.id }))

          const agentName = syncContactName(msg.from, msg.from_name)
          onInbound(
            msg.from, emoji, msg.id, msg.ts,
            'reaction', agentName ?? undefined,
            msg.group_id, msg.group_name,
            msg.message_id,
          )
        } catch (err) {
          process.stderr.write(
            `attn: failed to process reaction from ${msg.from}: ${err instanceof Error ? err.message : err}\n`,
          )
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
          if (msg.publicKey) {
            state.keyCache.set(addr, msg.publicKey)
            saveKeyCache(addr, msg.publicKey)
          }
          for (const cb of callbacks) cb(msg.publicKey)
        }
        break
      }

      case 'resolve_response': {
        const resolveMsg = msg as Extract<typeof msg, { type: 'resolve_response' }>
        const timeout = resolveTimeouts.get(resolveMsg.name)
        if (timeout) {
          clearTimeout(timeout)
          resolveTimeouts.delete(resolveMsg.name)
        }
        const callbacks = state.pendingResolveRequests.get(resolveMsg.name)
        if (callbacks) {
          state.pendingResolveRequests.delete(resolveMsg.name)
          const address = resolveMsg.address
          const publicKey = resolveMsg.publicKey
          if (address) {
            if (publicKey) {
              state.keyCache.set(address.toLowerCase(), publicKey)
              saveKeyCache(address.toLowerCase(), publicKey)
            }
            for (const cb of callbacks) cb({ address: address.toLowerCase(), publicKey: publicKey ?? null })
          } else {
            for (const cb of callbacks) cb(null)
          }
        }
        break
      }

      case 'received':
      case 'delivered':
        break

      case 'presence_response': {
        const pr = msg as Extract<typeof msg, { type: 'presence_response' }>
        const addr = pr.address.toLowerCase()
        const timeout = presenceTimeouts.get(addr)
        if (timeout) { clearTimeout(timeout); presenceTimeouts.delete(addr) }
        const callbacks = state.pendingPresenceRequests.get(addr)
        if (callbacks) {
          state.pendingPresenceRequests.delete(addr)
          for (const cb of callbacks) cb({ state: pr.state, message: pr.message })
        }
        break
      }

      case 'delivery_status': {
        const ds = msg as Extract<typeof msg, { type: 'delivery_status' }>
        if (ds.recipient_state === 'away' && awayNotifier) {
          const to = ds.to.toLowerCase()
          const now = Date.now()
          const last = state.awayNoticesLastAt.get(to) ?? 0
          if (now - last > AWAY_NOTICE_DEDUPE_MS) {
            if (state.awayNoticesLastAt.size >= AWAY_NOTICES_CAP) {
              for (const [k, v] of state.awayNoticesLastAt) {
                if (now - v > AWAY_NOTICE_DEDUPE_MS) state.awayNoticesLastAt.delete(k)
              }
            }
            state.awayNoticesLastAt.set(to, now)
            try { awayNotifier(to, ds.recipient_message ?? null) } catch {}
          }
        }
        break
      }

      case 'error':
        process.stderr.write(`attn: relay error: ${msg.error}\n`)
        break
    }
  })

  ws.addEventListener('close', () => {
    // Ignore stale close events from an abandoned ws (replaced by a newer one)
    if (state.ws !== null && state.ws !== ws) {
      process.stderr.write(`attn: ignoring stale close event from replaced ws\n`)
      return
    }
    teardownWsState()
    writeStatusFile()
    process.stderr.write(`attn: disconnected\n`)
    scheduleReconnect()
  })

  ws.addEventListener('error', () => {
    process.stderr.write(`attn: websocket error event (readyState=${ws.readyState})\n`)
    // OPEN-state errors will emit close; CONNECTING/CLOSED won't — recover manually.
    // See forceReconnect() docs for the Bun close-on-CONNECTING background.
    if ((ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.CLOSED) && state.ws === ws) {
      forceCleanupAndReconnect(`error event on ws (readyState=${ws.readyState})`)
    }
  })
}

async function processFileRef(plaintext: string): Promise<{ displayContent: string; filePath?: string }> {
  if (!plaintext.startsWith('{"type":"file"')) {
    return { displayContent: plaintext }
  }

  try {
    const fileRef = JSON.parse(plaintext) as {
      type: string; url: string; key: string; filename: string; size: number; mime: string
    }
    if (fileRef.type !== 'file' || !fileRef.url) {
      return { displayContent: plaintext }
    }

    const resp = await fetch(fileRef.url)
    if (!resp.ok) {
      return { displayContent: `(file: ${fileRef.filename}, ${formatSize(fileRef.size)}) — download failed` }
    }

    const encryptedData = new Uint8Array(await resp.arrayBuffer())
    const decryptedData = decryptBinary(state.privateKey, encryptedData)

    const inboxDir = getInboxDir()
    const safeName = `${Date.now()}-${fileRef.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const filePath = join(inboxDir, safeName)
    await Bun.write(filePath, decryptedData)

    return {
      displayContent: `(file: ${fileRef.filename}, ${formatSize(fileRef.size)}) saved to ${filePath}`,
      filePath,
    }
  } catch (err) {
    return { displayContent: `(file transfer failed: ${err instanceof Error ? err.message : 'unknown error'})` }
  }
}

function flushOutbox(ws: WebSocket): void {
  const items = getOutbox()
  if (items.length === 0) return
  process.stderr.write(`attn: flushing ${items.length} queued outbound message(s)\n`)

  const sent: string[] = []
  const failed: string[] = []

  for (const item of items) {
    if (item.attempts >= 10) {
      sent.push(item.id)
      process.stderr.write(`attn: outbox message ${item.id} failed after 10 attempts, discarding\n`)
      continue
    }
    try {
      ws.send(
        JSON.stringify({
          type: 'message',
          id: item.id,
          to: item.to_address,
          encrypted: item.encrypted,
          signature: item.signature,
        }),
      )
      sent.push(item.id)
    } catch {
      failed.push(item.id)
    }
  }

  for (const id of sent) deleteOutbox(id)
  for (const id of failed) incrementOutboxAttempts(id)
}

export function requestKey(address: string): Promise<string | null> {
  const cached = state.keyCache.get(address.toLowerCase())
  if (cached) return Promise.resolve(cached)

  const dbCached = getKeyCache(address.toLowerCase())
  if (dbCached) {
    state.keyCache.set(address.toLowerCase(), dbCached)
    return Promise.resolve(dbCached)
  }

  // No cache and no WS — can't fetch over network, fail fast so callers don't hang
  if (!isRelayReady()) {
    return Promise.resolve(null)
  }

  return new Promise((resolve) => {
    const addr = address.toLowerCase()
    const existing = state.pendingKeyRequests.get(addr) ?? []
    existing.push(resolve)
    state.pendingKeyRequests.set(addr, existing)

    if (existing.length === 1 && isRelayReady()) {
      try {
        state.ws!.send(JSON.stringify({ type: 'get_key', address: addr }))
      } catch (err) {
        process.stderr.write(`attn: requestKey send failed: ${err instanceof Error ? err.message : err}\n`)
        state.pendingKeyRequests.delete(addr)
        resolve(null)
        return
      }

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

export function requestResolve(name: string): Promise<{ address: string; publicKey: string | null } | null> {
  return new Promise((resolve) => {
    const label = name.toLowerCase()
    const existing = state.pendingResolveRequests.get(label) ?? []
    existing.push(resolve)
    state.pendingResolveRequests.set(label, existing)

    if (existing.length === 1 && isRelayReady()) {
      try {
        state.ws!.send(JSON.stringify({ type: 'resolve', name: label }))
      } catch (err) {
        process.stderr.write(`attn: requestResolve send failed: ${err instanceof Error ? err.message : err}\n`)
        state.pendingResolveRequests.delete(label)
        resolve(null)
        return
      }

      // Short timeout — relay round-trip is fast; long waits just delay the
      // HTTP/on-chain fallback for callers that cascade.
      const timeout = setTimeout(() => {
        resolveTimeouts.delete(label)
        const cbs = state.pendingResolveRequests.get(label)
        if (cbs) {
          state.pendingResolveRequests.delete(label)
          for (const cb of cbs) cb(null)
        }
      }, 3000)
      resolveTimeouts.set(label, timeout)
    }
  })
}

// Independent supervisor watchdog. Ticks every 30s regardless of WS state.
// Tracks the last moment isRelayReady() was true. If we've been unhealthy for
// more than UNHEALTHY_GRACE_MS AND the session actually uses the relay, force
// a full cleanup + reconnect — even if no timer is currently armed and no
// event is expected to fire.
//
// This is the safety net that closes the "entire reconnect loop is broken"
// bug class permanently. Every other watchdog lives *inside* the WS lifecycle
// (pong watchdog tied to pingInterval, auth handshake watchdog tied to a
// specific ws) — once the loop breaks upstream of those, nothing can notice.
// This one runs outside of all that and only cares about the wall-clock
// readiness of the relay connection.
const UNHEALTHY_GRACE_MS = 120_000
const HEALTH_TICK_MS = 30_000

export function startHealthWatchdog(): void {
  if (healthWatchdogTimer) clearInterval(healthWatchdogTimer)
  lastHealthyAt = Date.now()
  healthWatchdogTimer = setInterval(() => {
    // Local-only derived sessions never touch the relay — nothing to supervise.
    if (getSessionType() === 'local') return

    if (isRelayReady()) {
      lastHealthyAt = Date.now()
      return
    }

    const unhealthyMs = Date.now() - lastHealthyAt
    if (unhealthyMs < UNHEALTHY_GRACE_MS) return

    // Stuck for >2 minutes. Assume the reconnect loop is wedged and force
    // recovery. Reset the delay so the next attempt fires promptly — after
    // a long stall, aggressive backoff isn't helpful.
    process.stderr.write(
      `attn: health watchdog triggering recovery — unhealthy for ${Math.floor(unhealthyMs / 1000)}s, relay=${getRelayStatus()}\n`,
    )
    reconnectDelay = 1000
    forceCleanupAndReconnect(`health watchdog (${Math.floor(unhealthyMs / 1000)}s stuck)`)
    // Reset grace window so a slow recovery doesn't retrigger us immediately.
    lastHealthyAt = Date.now()
  }, HEALTH_TICK_MS)
}

export function stopHealthWatchdog(): void {
  if (healthWatchdogTimer) { clearInterval(healthWatchdogTimer); healthWatchdogTimer = null }
}

export function requestPresence(address: string): Promise<{ state: PresenceState; message: string | null } | null> {
  if (!isRelayReady()) return Promise.resolve(null)
  return new Promise((resolve) => {
    const addr = address.toLowerCase()
    const existing = state.pendingPresenceRequests.get(addr) ?? []
    existing.push(resolve)
    state.pendingPresenceRequests.set(addr, existing)

    if (existing.length === 1) {
      try {
        state.ws!.send(JSON.stringify({ type: 'presence_query', address: addr }))
      } catch (err) {
        process.stderr.write(`attn: requestPresence send failed: ${err instanceof Error ? err.message : err}\n`)
        state.pendingPresenceRequests.delete(addr)
        resolve(null)
        return
      }
      const timeout = setTimeout(() => {
        presenceTimeouts.delete(addr)
        const cbs = state.pendingPresenceRequests.get(addr)
        if (cbs) {
          state.pendingPresenceRequests.delete(addr)
          for (const cb of cbs) cb(null)
        }
      }, PRESENCE_QUERY_TIMEOUT_MS)
      presenceTimeouts.set(addr, timeout)
    }
  })
}

export function setPresence(newState: PresenceState, message: string | null): void {
  const prev = state.presence
  state.presence = newState
  state.presenceMessage = message

  if (prev === 'away' && newState === 'online') {
    state.returningFromAwayAt = Date.now()
    state.awaySummaryBuffer = 0
    if (state.awaySummaryTimer) clearTimeout(state.awaySummaryTimer)
    state.awaySummaryTimer = setTimeout(() => {
      const count = state.awaySummaryBuffer
      state.awaySummaryBuffer = 0
      state.returningFromAwayAt = null
      state.awaySummaryTimer = null
      if (count > 0 && awaySummaryNotifier) {
        try { awaySummaryNotifier(count) } catch {}
      }
    }, AWAY_SUMMARY_WINDOW_MS)
  }

  savePresence(newState, message)
  writeStatusFile()

  if (isRelayReady()) {
    try {
      state.ws!.send(JSON.stringify({ type: 'presence_set', state: newState, message }))
    } catch (err) {
      process.stderr.write(`attn: setPresence send failed: ${err instanceof Error ? err.message : err}\n`)
    }
  }
}

export function cleanup(): void {
  if (pingInterval) { clearInterval(pingInterval); pingInterval = null }
  if (authHandshakeTimer) { clearTimeout(authHandshakeTimer); authHandshakeTimer = null }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  stopHealthWatchdog()
  if (state.ws) {
    try { state.ws.close() } catch {}
  }
}
