# Build attn-core + attn-pi

Build a platform-agnostic attn daemon and pi extension for encrypted agent-to-agent messaging,
using the existing s0nderlabs relay (wss://attn.s0nderlabs.xyz/ws).

## Architecture (already designed — implement)

```
attn-core daemon (localhost:9742)
├── HTTP REST: POST /send, GET /peers, GET /history, POST /contacts, GET /status
├── WebSocket: ws://localhost:9742 — pushes inbound messages to clients in real-time
├── Relay WS: connects to wss://attn.s0nderlabs.xyz/ws (same protocol as upstream)
├── Identity: 0x-prefixed hex private key at ~/.attn/.env (auto-generates on first run)
├── Crypto: eciesjs + viem (identical to upstream attn)
└── DB: better-sqlite3 at ~/.attn/history.db (messages, contacts, key cache)

attn-pi extension (~/.pi/agent/extensions/attn.ts)
├── Connects to daemon WS for real-time inbound messages
├── Injects notifications via pi.sendUserMessage()
├── Registers tools: attn_send, attn_peers, attn_reply, attn_history
└── Auto-starts daemon if not running
```

## Build Plan

### Step 1: attn-core daemon (~600 lines)

Create project at ~/.pi/agent/repositories/attn-core/

Files to create:
- package.json — dependencies: eciesjs, viem, better-sqlite3, ws, @types/ws, @types/better-sqlite3, typescript
- tsconfig.json — target ES2022, module NodeNext
- src/index.ts — main entry: starts HTTP+WS server, connects relay, loads identity
- src/crypto.ts — port from upstream attn/packages/plugin/src/crypto.ts (same eciesjs+viem API)
- src/env.ts — identity generation/loading, state dir at ~/.attn/
- src/db.ts — better-sqlite3 (drop-in for bun:sqlite from upstream history.ts — messages, contacts, key_cache tables)
- src/relay.ts — port from upstream attn/packages/plugin/src/ws.ts (WebSocket to relay, auth, reconnect loop)
- src/server.ts — HTTP REST API + WebSocket server on localhost:9742
- src/local.ts — local peer discovery (same named-pipe/socket logic, works on Windows)

### Step 2: attn-pi extension (~200 lines)

Create ~/.pi/agent/extensions/attn/index.ts
- Opens WS to ws://localhost:9742
- On inbound message → pi.sendUserMessage()
- Registers tools: attn_send, attn_peers, attn_reply, attn_history
- Registers command /attn-status

### Step 3: Test

- Start daemon: node dist/index.js
- Verify identity generated at ~/.attn/.env
- Verify relay connects
- Test send/peers/history via curl
- Load pi with extension, test attn_send tool

## Key constraints

- Use the EXISTING relay at wss://attn.s0nderlabs.xyz/ws — don't build a relay
- Same crypto as upstream: eciesjs encrypt/decrypt, viem for key derivation + signing
- better-sqlite3 is synchronous (like bun:sqlite) — keep same API pattern
- Daemon prints all logs to stderr, nothing to stdout
- Works on Windows (named pipes for local peers, %USERPROFILE%/.attn for state dir)
- No Bun dependency — pure Node.js
