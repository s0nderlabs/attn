#!/usr/bin/env bun
import { resolvePrivateKey, getRelayUrl } from './src/env.js'
import { deriveIdentity } from './src/crypto.js'
import { initDb } from './src/history.js'
import { state } from './src/state.js'
import { connectMcp, notifyInbound } from './src/server.js'
import { connectToRelay, cleanup } from './src/ws.js'

// Global error handlers
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

// 2. Initialize history DB
initDb()

// 3. Connect MCP (stdio transport)
const mcp = await connectMcp()

// 4. Connect to relay
const relayUrl = getRelayUrl()
connectToRelay(relayUrl, (from, plaintext, id, ts) => {
  notifyInbound(mcp, from, plaintext, id, ts)
})

// 5. Shutdown handlers
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
