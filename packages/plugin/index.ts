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

// 5. Shutdown
let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('attn: shutting down\n')
  cleanup()
  setTimeout(() => process.exit(0), 2000)
}

process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// Parent PID watchdog — exit if parent dies (prevents orphan processes)
const parentPid = process.ppid
if (parentPid && parentPid > 1) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0) // test if parent is alive (signal 0 = no-op)
    } catch {
      process.stderr.write('attn: parent process died, exiting\n')
      shutdown()
    }
  }, 5000)
}
