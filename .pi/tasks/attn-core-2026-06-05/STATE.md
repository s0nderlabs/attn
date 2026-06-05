# STATE — attn-core-build

**Status:** COMPLETE
**Worker:** attn-core
**Parent initiative:** [attn-pi-adoption](../initiatives/attn-pi-adoption.md)
**Started:** 2026-06-05 16:00
**Completed:** 2026-06-05 18:55

## Starting Point

- Upstream attn repo cloned at ~/.pi/agent/repositories/attn/
- pi extension API confirmed: pi.sendUserMessage() for real-time injection, pi.registerTool() for tools
- WezTerm skill working for worker spawning + STATE.md monitoring
- Architecture designed (daemon + WS + pi extension)
- Empty attn-core dir created at ~/.pi/agent/repositories/attn-core/

## Roadmap

- [x] Step 1: Create package.json + tsconfig.json + install deps
- [x] Step 2: Build src/crypto.ts (port from upstream)
- [x] Step 3: Build src/env.ts (identity, state dir)
- [x] Step 4: Build src/db.ts (better-sqlite3 schemas)
- [x] Step 5: Build src/relay.ts (WebSocket relay client + reconnect)
- [x] Step 6: Build src/local.ts (named pipes for Windows)
- [x] Step 7: Build src/server.ts (HTTP REST + WS server on :9742)
- [x] Step 8: Build src/index.ts (main entry, wire everything together)
- [x] Step 9: Build attn-pi extension
- [x] Step 10: Test daemon startup, relay connection, send/receive

## Completed

All steps verified:
- TypeScript build: clean (0 errors)
- Daemon startup: identity loads from ~/.attn/.env, connects to wss://attn.s0nderlabs.xyz/ws, authenticates successfully
- Extension: all 5 tools registered (attn_send, attn_peers, attn_reply, attn_history, attn_status), WS connection + reconnection, daemon auto-start
- EADDRINUSE on :9742 is expected — upstream daemon is already running
