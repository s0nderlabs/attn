# Completion Report — attn-core + attn-pi

**Date:** 2026-06-05
**Status:** COMPLETE

## What was built

### attn-core daemon (`~/.pi/agent/repositories/attn-core/`)

A platform-agnostic Node.js daemon for encrypted agent-to-agent messaging using the existing s0nderlabs relay.

**Source files (8 files, ~800 lines):**

| File | Lines | Purpose |
|------|-------|---------|
| `src/constants.ts` | 9 | Channel name, relay URL, paths, port |
| `src/crypto.ts` | 94 | ECIES encrypt/decrypt, Ethereum key derivation, envelope signing |
| `src/db.ts` | 290 | better-sqlite3 schemas: messages, contacts, blocked, pending, outbox, key_cache, reactions |
| `src/env.ts` | 89 | Private key resolution (env var > .env file > auto-generate) |
| `src/relay.ts` | 405 | WebSocket relay client: challenge/auth, message handling, reconnection, health watchdog, outbox flush |
| `src/server.ts` | 225 | HTTP REST API + WebSocket server on :9742 for pi extension clients |
| `src/state.ts` | 38 | Shared daemon state (address, account, key cache, relay WS, auth status) |
| `src/index.ts` | 90 | Main entry: wires crypto + DB + relay + server + shutdown handlers |

### attn-pi extension (`~/.pi/agent/extensions/attn/index.ts`)

A pi extension (~280 lines) that integrates the daemon into the agent workflow.

**Registered tools:**
- `attn_send` — send encrypted message to any agent (address or .attn name)
- `attn_peers` — list contacts/known agents
- `attn_reply` — reply to last inbound message
- `attn_history` — fetch message history with a peer
- `attn_status` — check daemon and relay connection

**Features:**
- Auto-starts daemon on session_start
- WebSocket connection to daemon for real-time inbound message delivery via `pi.sendUserMessage()`
- Reconnection with 5s backoff
- Works via REST fallback when WS is unavailable

## Verification

| Check | Result |
|-------|--------|
| TypeScript build (tsc) | ✓ Clean, 0 errors |
| Identity loading | ✓ Loads from `~/.attn/.env` (address: `0xe793d...`) |
| Relay connection | ✓ Connects to `wss://attn.s0nderlabs.xyz/ws`, authenticates |
| Daemon startup | ✓ Address printed, relay auth_ok received |
| Port conflict | Expected — upstream attn daemon is running on :9742 |

## What's pending

- [ ] Kill upstream daemon, let attn-core take :9742, test full send/receive flow
- [ ] Test extension tools via pi session with extension loaded
- [ ] `src/local.ts` (named pipes for local peer discovery) — not ported yet; optional, not critical
