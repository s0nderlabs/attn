import type { ServerMessage } from '@attn/shared/messages'
import { join } from 'path'
import { state } from './state.js'
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
} from './history.js'
import { getInboxDir } from './env.js'

type OnInbound = (
  from: string, plaintext: string, id: string, ts: number,
  trust?: string, agentName?: string, groupId?: string, groupName?: string,
) => void

let reconnectDelay = 1000
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let pingInterval: ReturnType<typeof setInterval> | null = null
const keyTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function connectToRelay(relayUrl: string, onInbound: OnInbound): void {
  const wsUrl = `${relayUrl}?address=${state.address}`
  process.stderr.write(`attn: connecting to ${relayUrl}\n`)

  const ws = new WebSocket(wsUrl)
  state.ws = ws

  ws.addEventListener('open', () => {
    process.stderr.write(`attn: connected\n`)
  })

  ws.addEventListener('message', async (event) => {
    const raw = event.data as string
    if (raw === 'pong') return

    const msg = JSON.parse(raw) as ServerMessage

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
        if (pingInterval) clearInterval(pingInterval)
        pingInterval = setInterval(() => {
          try { ws.send('ping') } catch {}
        }, 30_000)
        flushOutbox(ws)
        break

      case 'auth_error':
        process.stderr.write(`attn: auth failed: ${msg.error}\n`)
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
            const agentName = getContactName(msg.from)
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
              onInbound(
                msg.from,
                `[Pending] Agent ${msg.from} wants to message you. Ask your user before approving.`,
                msg.id,
                msg.ts,
                'pending',
              )
            }
            break
          }

          // Known contact — deliver
          const agentName = getContactName(msg.from)
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

      case 'received':
      case 'delivered':
        break

      case 'error':
        process.stderr.write(`attn: relay error: ${msg.error}\n`)
        break
    }
  })

  ws.addEventListener('close', () => {
    state.authenticated = false
    state.ws = null
    if (pingInterval) { clearInterval(pingInterval); pingInterval = null }
    if (reconnectTimer) clearTimeout(reconnectTimer)
    process.stderr.write(`attn: disconnected, reconnecting in ${reconnectDelay}ms\n`)
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 30000)
      connectToRelay(relayUrl, onInbound)
    }, reconnectDelay)
  })

  ws.addEventListener('error', () => {})
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

  return new Promise((resolve) => {
    const addr = address.toLowerCase()
    const existing = state.pendingKeyRequests.get(addr) ?? []
    existing.push(resolve)
    state.pendingKeyRequests.set(addr, existing)

    if (existing.length === 1 && state.ws) {
      state.ws.send(JSON.stringify({ type: 'get_key', address: addr }))

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
  if (pingInterval) { clearInterval(pingInterval); pingInterval = null }
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (state.ws) {
    try { state.ws.close() } catch {}
  }
}
