#!/usr/bin/env bun
import { resolvePrivateKey, getRelayUrl, getInboxDir } from './src/env.js'
import { deriveIdentity } from './src/crypto.js'
import { initDb, expirePending, getAllKeyCache } from './src/history.js'
import { state } from './src/state.js'
import { connectMcp, notifyInbound } from './src/server.js'
import { connectToRelay, cleanup } from './src/ws.js'

process.on('unhandledRejection', (err) => {
  process.stderr.write(`attn: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', (err) => {
  process.stderr.write(`attn: uncaught exception: ${err}\n`)
})

// 1. Load private key
const privateKey = resolvePrivateKey()
const { address, account } = deriveIdentity(privateKey)

state.privateKey = privateKey
state.address = address
state.account = account

process.stderr.write(`attn: agent address ${address}\n`)

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

// 4. Connect to relay
const relayUrl = getRelayUrl()
connectToRelay(relayUrl, (from, plaintext, id, ts, trust?, agentName?, groupId?, groupName?) => {
  notifyInbound(mcp, from, plaintext, id, ts, trust, agentName, groupId, groupName)
})

// 5. Shutdown — detect stdin EOF (Claude Code closing pipe) + force exit
process.stdin.resume() // critical: ensures end/close events fire when pipe closes

let shuttingDown = false
function shutdown(reason: string) {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write(`attn: shutting down (${reason})\n`)
  setTimeout(() => process.exit(0), 3000) // force exit if cleanup hangs
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
