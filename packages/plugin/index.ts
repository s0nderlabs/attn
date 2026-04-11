#!/usr/bin/env bun
import { resolvePrivateKey, getRelayUrl, getInboxDir, getSessionName, isExternalEnabled } from './src/env.js'
import { deriveIdentity, deriveSessionKey } from './src/crypto.js'
import { initDb, expirePending, getAllKeyCache, saveMessage, saveReaction } from './src/history.js'
import { state } from './src/state.js'
import { connectMcp, notifyInbound } from './src/server.js'
import { connectToRelay, cleanup, startHealthWatchdog } from './src/ws.js'
import { checkDuplicateSession, writePeerInfo, startLocalServer, cleanupLocal } from './src/local.js'
import { startStatusHeartbeat, stopStatusHeartbeat } from './src/status.js'
import type { LocalMessage } from './src/local.js'

process.on('unhandledRejection', (err) => {
  process.stderr.write(`attn: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', (err) => {
  process.stderr.write(`attn: uncaught exception: ${err}\n`)
})

// 1. Load private key + session identity
const rootKey = resolvePrivateKey()
const sessionName = getSessionName()

let privateKey: `0x${string}` = rootKey
let effectiveName = 'main'

if (sessionName) {
  privateKey = deriveSessionKey(rootKey, sessionName)
  effectiveName = sessionName
}

const { address, account } = deriveIdentity(privateKey)

state.privateKey = privateKey
state.address = address
state.account = account
state.sessionName = sessionName

process.stderr.write(`attn: session "${effectiveName}" address ${address}\n`)

// 2. Initialize DB + maintenance
initDb()
getInboxDir()

const expired = expirePending(30 * 24 * 60 * 60 * 1000)
if (expired > 0) process.stderr.write(`attn: expired ${expired} stale pending message(s)\n`)

const cachedKeys = getAllKeyCache()
for (const entry of cachedKeys) state.keyCache.set(entry.address, entry.public_key)
if (cachedKeys.length > 0) process.stderr.write(`attn: loaded ${cachedKeys.length} cached key(s)\n`)

// 3. Connect MCP
const mcp = await connectMcp()

// 4. Check for duplicate session + start local server
try {
  checkDuplicateSession(effectiveName)
} catch (err) {
  process.stderr.write(`attn: ${err instanceof Error ? err.message : err}\n`)
  process.exit(1)
}
writePeerInfo(effectiveName, address)

// Start publishing status file (consumed by statusline scripts, tmux widgets, etc.)
startStatusHeartbeat()

const localServer = startLocalServer(effectiveName, (msg: LocalMessage) => {
  const id = crypto.randomUUID()

  // Local reaction
  if (msg.reaction_for) {
    saveReaction({
      message_id: msg.reaction_for,
      from_address: msg.fromAddress,
      emoji: msg.text,
      ts: new Date(msg.ts).toISOString(),
    })
    notifyInbound(mcp, msg.fromAddress, msg.text, id, msg.ts, 'reaction', msg.from, undefined, undefined, msg.reaction_for)
    return
  }

  // Regular local message
  saveMessage({
    id,
    peer: msg.from,
    direction: 'inbound',
    content: msg.text,
    ts: new Date(msg.ts).toISOString(),
  })
  if (msg.group === 'local') {
    notifyInbound(mcp, msg.fromAddress, msg.text, id, msg.ts, 'local', msg.from, undefined, 'local')
  } else {
    notifyInbound(mcp, msg.fromAddress, msg.text, id, msg.ts, 'local', msg.from)
  }
  // Override after notifyInbound — preserve session name for local reply/react routing
  state.lastInboundFrom = msg.from
  state.lastInboundGroup = msg.group === 'local' ? 'all' : null
})
state.localServer = localServer

// 5. Connect to relay (main session or ATTN_EXTERNAL=1)
if (!state.sessionName || isExternalEnabled()) {
  const relayUrl = getRelayUrl()
  connectToRelay(relayUrl, (from, plaintext, id, ts, trust?, agentName?, groupId?, groupName?, reactionMessageId?) => {
    notifyInbound(mcp, from, plaintext, id, ts, trust, agentName, groupId, groupName, reactionMessageId)
  })
  // Independent supervisor: catches stuck reconnect loops that no per-ws
  // watchdog can see. Safety net for Bun's close-on-CONNECTING edge case.
  startHealthWatchdog()
} else {
  process.stderr.write(`attn: local-only (no relay)\n`)
}

// 6. Shutdown — detect stdin EOF (Claude Code closing pipe) + force exit
process.stdin.resume()

let shuttingDown = false
function shutdown(reason: string) {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write(`attn: shutting down (${reason})\n`)
  setTimeout(() => process.exit(0), 3000)
  try { stopStatusHeartbeat() } catch {}
  try { cleanupLocal(effectiveName) } catch {}
  try { cleanup() } catch {}
  process.exit(0)
}

process.stdin.on('end', () => shutdown('stdin end'))
process.stdin.on('close', () => shutdown('stdin close'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// Parent PID watchdog — safety net for orphan prevention
const parentPid = process.ppid
if (parentPid && parentPid > 1) {
  setInterval(() => {
    try { process.kill(parentPid, 0) }
    catch { shutdown('parent died') }
  }, 5000)
}
