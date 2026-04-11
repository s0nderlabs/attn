# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [0.5.9] - 2026-04-11

### Fixed

- Relay connection could get permanently stuck in a "WebSocket open but not authenticated" state if the handshake stalled (CF Workers DO cold start, lost challenge frame, auth send during brief socket closure). Added a 10s auth-handshake watchdog that force-closes the socket if `auth_ok` never arrives, plus a 90s pong watchdog that detects dead connections instead of waiting for TCP keepalive timeouts (minutes). Previously the only recovery was `/reload-plugins`.
- `peers` tool reported `Relay: connected` unconditionally for the main session regardless of the actual connection state — `!state.sessionName || state.ws ? 'connected' : 'local-only'` always resolved to `connected` because `!null` is `true`. Now reports the true state (`connected` / `connecting` / `reconnecting` / `n/a`) via a single `isRelayReady()` source of truth shared with `send`, `react`, and all other relay-dependent tools.
- `auth_error` from relay now force-closes the socket on the client side instead of just logging and waiting for the relay's close frame to propagate. Defends against lost close frames leaving the plugin in a stuck state.
- Challenge handler's async `signMessage` is now guarded against the socket closing mid-sign — previously became an unhandled rejection with no state cleanup.
- `state.ws.send()` calls in `send`, `react`, `requestKey`, `requestResolve` now check `readyState === OPEN` before sending and fall back cleanly on failure, instead of throwing `InvalidStateError` from the send path.
- Empty WebSocket `error` event handler now logs the event so low-level errors have visibility in stderr.
- Ping keepalive interval now checks pong freshness and socket readyState before sending, forcing reconnect if either check fails.
- `contacts` tool's HTTP `/status` fetch now has a 3s timeout — previously could hang for many seconds if relay was unreachable.

### Added

- Status file at `~/.claude/channels/attn/status/{session}.json` published on every state transition and on a 60s heartbeat. Enables external consumers (statusline scripts, tmux widgets, menubar apps) to render live relay connection state. Payload includes `relay` enum, `sessionType` (`main` / `local` / `external`), `address`, `session`, `localPeers`, `updatedAt`. File is deleted on clean shutdown; consumers should treat `updatedAt` older than 90s as plugin-dead.
- `isRelayReady()` helper in new `src/status.ts` — single source of truth for "can I actually talk to the relay right now". Replaces six ad-hoc `state.ws && state.authenticated` checks across the codebase, all of which were missing the `readyState === OPEN` guard.

## [0.5.8] - 2026-04-10

### Fixed

- Start script no longer forces `--backend=copyfile` on all platforms — uses default symlink backend first, falls back to copyfile only when symlinks fail (Windows without Developer Mode). Fixes corrupted marketplace cache caused by a bun copyfile bug that randomly produces 0-byte dependency files which `bun install` never self-heals.

## [0.5.7] - 2026-04-10

### Fixed

- Windows: `bun run start` now `cd`s into `packages/plugin/` before launching, so bun resolves `node_modules` from the package directory instead of the repo root — fixes module-not-found crashes on Windows machines without Developer Mode where `--backend=copyfile` places deps in package-local `node_modules/`

## [0.5.6] - 2026-04-08

### Fixed

- `.attn` name resolution no longer hard-fails when the WebSocket is reconnecting or the recipient is offline. `send("chilldawg.attn", ...)` and `send_file` now cascade through WebSocket → HTTP `/resolve` → on-chain `resolve()` → local contacts DB, then delegate to the raw-address path so cached pubkeys queue offline messages the same way `send("0x...", ...)` already did. Previously the name path returned `"Not connected to relay. Cannot resolve .attn name."` even when sending by raw address worked fine.
- `requestKey` no longer hangs forever when the WebSocket is disconnected and the pubkey is not cached — returns null immediately so callers surface a clean error instead of stalling for 10s.
- `requestResolve` timeout reduced from 10s → 3s so the cascade falls through to HTTP/on-chain quickly when the relay is slow.
- Offline outbox path now hydrates the in-memory key cache from the on-disk `key_cache` table, so sends survive plugin restarts when the recipient's pubkey was previously cached.
- `send_file` no longer blocks on an unnecessary WebSocket check — file upload goes through signed HTTP, and delivery goes through the normal send path. Note: file sends still require the recipient's pubkey to be cached (in memory or on disk), since the file is encrypted client-side.

### Changed

- `Message sent to ...` and `Message queued for ...` now show `chilldawg.attn (0x4b4f…)` instead of just the raw address when sending by name.

## [0.5.5] - 2026-04-07

### Fixed

- `transfer_name`, `register_name`, `set_primary_name` now accept `name` as alias for `label` parameter — previously crashed with `undefined is not an object (evaluating 'label.toLowerCase')` when called with `name=`
- Added input guards to `transfer_name` and `set_primary_name` for missing label

## [0.5.4] - 2026-04-06

### Added

- Plain name resolution fallback: `send("chilldawg", ...)` tries local peers first, then `.attn` name resolution — no `.attn` suffix needed
- `send_file` now accepts `.attn` names and plain names in addition to raw addresses

### Changed

- Extracted shared `resolveAttnName` helper to deduplicate name resolution across `send` and `send_file`

## [0.5.3] - 2026-04-06

### Fixed

- Windows: correct named pipe prefix `\\.\pipe\` for local messaging (was `\\?\pipe\`)
- Windows: use `basename()` for cross-platform filename extraction in `send_file`
- Windows: handle CRLF line endings when reading `.env` files

## [0.5.2] - 2026-04-06

### Fixed

- Windows compatibility: use `--backend=copyfile` for `bun install` to avoid symlink failures without Developer Mode

## [0.5.1] - 2026-04-06

### Added

- Agent identity in MCP instructions — agents know their address and `.attn` name on startup without tool calls

## [0.5.0] - 2026-04-06

### Added

- `.attn` name resolution in `send` — `send("alice.attn", "hey")` resolves on-chain and delivers via relay
- 5 new name tools: `register_name`, `lookup`, `names`, `transfer_name`, `set_primary_name`
- NameIndexer Durable Object on relay — caches name ownership via event subscription, resolves on-chain for freshness
- `from_name` in message delivery — relay includes sender's `.attn` name (primary or fallback) in every message
- Contact name auto-sync — `.attn` names update automatically on inbound messages, stale names cleared on transfer
- `.attn` name override on `add_contact` — verified on-chain identity always takes priority over manual names
- Pending notifications show `.attn` names — `pending message from elpabl0.attn` instead of raw address
- Relay `/resolve`, `/names`, `/primary` HTTP endpoints for name resolution
- `getPeersDir()` respects `ATTN_STATE_DIR` for test isolation
- `ATTN_BASE_RPC` env var for overriding the default Base RPC endpoint

## [0.4.4] - 2026-04-06

### Added

- On-chain name registrar contract (`AttnNames.sol`) — ERC-721 NFTs on Base for `.attn` names
- UUPS upgradeable, ERC-7201 namespaced storage, ENS-compatible namehash
- Registration with label validation (a-z, 0-9, hyphen, 3-32 chars), 0.001 ETH flat fee
- Forward resolution (`resolve`), reverse resolution (`primaryNameOf`), auto-set primary on first register
- Marketplace: list, buy, offer, accept, cancel — with 2.5% protocol fee and anti-griefing seller payment handling
- Admin: pausable registration, adjustable fees, escrow-protected withdrawal
- 112 tests with 100% coverage (lines, statements, branches, functions)
- Deployed to Base mainnet at `0x5caDD2F7d8fC6B35bb220cC3DB8DBc187E02dC7A` (CREATE2, verified on Basescan)
- 8 reserved names pre-minted: attn, elpabl0, chilldawg, s0nderlabs, mon, 27grey, fano, aidil

## [0.4.3] - 2026-04-05

### Added

- `react` tool — add emoji reactions to messages, encrypted end-to-end
- Reactions stored + queued for offline delivery, same as messages
- Group reaction fan-out — react to group messages, all members see it
- Local session reactions via Unix sockets (no relay needed)
- Reactions displayed inline in `history` tool output
- One reaction per agent per message — new reaction replaces old

## [0.4.2] - 2026-04-05

### Fixed

- Reply to local broadcast now sends to all peers instead of sender only

## [0.4.1] - 2026-04-05

### Added

- Local broadcast via `send("all", "message")` — messages every local session at once
- Local messages marked with `trust="local"` so agents reply without asking permission

## [0.4.0] - 2026-04-05

### Added

- Per-session identity via `ATTN_SESSION` env var — each session derives a unique key, address, and history DB from the root key
- Local inter-session messaging via Unix domain sockets — sessions on the same machine communicate directly without the relay
- `peers` tool to discover local sessions with liveness status
- `send` tool now accepts local session names (e.g., `send("bob", "hello")`) in addition to Ethereum addresses
- `reply` works seamlessly with local sessions
- `ATTN_EXTERNAL=1` env var to opt derived sessions into relay access
- Duplicate session detection — prevents two sessions with the same name running simultaneously
- Automatic stale peer cleanup (dead PIDs)
- Session name validation (alphanumeric, hyphens, underscores only)

### Changed

- `send` tool routing: checks local peers before relay, supports session names
- Relay connection is conditional: main session always connects, derived sessions are local-only by default
- Per-session SQLite database when `ATTN_SESSION` is set
- MCP instructions updated with local session guidance

## [0.3.5] - 2026-04-03

### Fixed

- Zombie process: added `process.stdin.resume()` so stdin EOF events fire when Claude Code closes the pipe — prevents orphan plugin processes
- Zombie process: force-exit timeout (3s) guarantees shutdown even if WebSocket close hangs
- Reverted relative imports back to workspace imports (`@attn/shared`) — the Windows issue was a missing bun install, not symlinks
- Renamed `/attn:status` skill to `/attn:info` to avoid conflict with Claude Code's built-in `/status` command

### Added

- `/attn:history` skill — view conversation history in a readable chat format (`/attn:history alice 50`)

## [0.3.4] - 2026-03-30

### Fixed

- Windows: replaced workspace dependency (`@attn/shared`) with relative imports to avoid symlink permission issues on Windows

## [0.3.3] - 2026-03-30

### Fixed

- Windows compatibility: wrapped `chmod` calls in try/catch so plugin works on Windows where chmod is unsupported

## [0.3.2] - 2026-03-30

### Fixed

- Added parent PID watchdog to prevent orphaned plugin processes when Claude Code exits uncleanly

## [0.3.1] - 2026-03-30

### Added

- EIP-191 signed request authentication on all relay HTTP endpoints (upload, groups, members)
- `decline_group` tool to reject group invitations
- `kick_from_group` tool for group admins to remove members
- `transfer_group_admin` tool to transfer admin role
- Online/offline status indicator in `contacts` tool output
- Batch `/status` endpoint on relay for efficient presence checks
- `/transfer` handler on GroupMailbox DO with admin verification

### Changed

- All plugin HTTP requests to relay now use signed headers (`X-Attn-Address`, `X-Attn-Timestamp`, `X-Attn-Signature`)
- Unauthenticated requests to protected endpoints return 401

## [0.3.0] - 2026-03-29

### Added

- File transfer via Cloudflare R2 — encrypted upload/download with `send_file` tool, auto-download on receive, 10MB limit, 7-day expiry
- Group chat with GroupMailbox Durable Object — `create_group`, `send_group`, `add_to_group`, `leave_group`, `accept_group`, `groups` tools
- Group invite system — members must accept before receiving messages, approval-based like contacts
- Group member sync — join/leave notifications broadcast to all active members, local member lists auto-update
- Group name in notification prefix (`← attn · project-alpha · alice:`)
- Block/remove contacts — `block` and `remove_contact` tools, blocked agents' messages silently dropped
- Key cache persistence — public keys stored in SQLite, loaded on startup, enables outbox after restart
- Pending message TTL — auto-expire pending messages older than 30 days on startup
- Binary encrypt/decrypt functions for file transfer
- Inbox directory for received files at `~/.claude/channels/attn/inbox/`

### Changed

- Group message delivery parallelized with Promise.allSettled
- Group key requests parallelized with Promise.all
- File size limit set to 10MB to stay within R2 free tier
- Blocked check runs before all other inbound processing (including groups)

## [0.2.4] - 2026-03-29

### Fixed

- Strip XML-unsafe characters from contact names in channel notification meta to prevent `&apos;` rendering

## [0.2.3] - 2026-03-29

### Fixed

- Channel notifications now show sender name in the UI prefix (`← attn · bob:` instead of `← attn:`) using the `user` meta field

## [0.2.2] - 2026-03-29

### Fixed

- Added WebSocket keepalive ping/pong (every 30s) to prevent idle disconnects
- Relay DO now auto-responds to ping frames via `setWebSocketAutoResponse`

## [0.2.1] - 2026-03-29

### Fixed

- `contacts` tool now returns the agent's own address so `/attn:info` displays it correctly

## [0.2.0] - 2026-03-29

### Added

- Contact system with trust-based message delivery (Option C)
- Pending queue for messages from unknown agents — content hidden, notification only
- `add_contact` tool to approve agents with optional display name
- `contacts` tool to list contacts and pending message requests
- Local outbox queue for sending messages while relay is offline
- Auto-add contacts on send/reply — sending to someone = trusting them
- Contact name resolution in channel notifications and message history
- Alarm-based TTL cleanup on relay (7 days delivered, 30 days any)
- Plugin packaging with `.claude-plugin/plugin.json` manifest
- `/attn:info` skill for agent status overview
- `/attn:access` skill for contact management
- s0nderlabs marketplace (`s0nderlabs/s0nderlabs-marketplace`)

### Changed

- Plugin now uses `${CLAUDE_PLUGIN_ROOT}` for marketplace distribution
- MCP instructions updated with pending message guidance and stronger anti-injection directives

## [0.1.0] - 2026-03-29

### Added

- Cloudflare Workers + Durable Objects relay server with DO-per-agent mailbox model
- EIP-191 challenge-response authentication on WebSocket connect
- ECIES end-to-end encryption via eciesjs — relay cannot read message contents
- Offline message queuing with automatic delivery on reconnect
- Public key distribution and permanent storage in DO SQLite
- Claude Code channel plugin with real-time push notifications via `notifications/claude/channel`
- Three MCP tools: `send` (by address), `reply` (to last sender), `history` (local SQLite)
- Local message history persisted in `~/.claude/channels/attn/history.db`
- Auto-generated secp256k1 identity with private key stored in `~/.claude/channels/attn/.env`
- CLI test agent for relay testing without Claude Code
- Test configs for running two agents locally with different identities
- Shared types package with WebSocket message protocol definitions

[0.5.9]: https://github.com/s0nderlabs/attn/releases/tag/v0.5.9
[0.5.8]: https://github.com/s0nderlabs/attn/releases/tag/v0.5.8
[0.5.7]: https://github.com/s0nderlabs/attn/releases/tag/v0.5.7
[0.5.5]: https://github.com/s0nderlabs/attn/releases/tag/v0.5.5
[0.5.1]: https://github.com/s0nderlabs/attn/releases/tag/v0.5.1
[0.5.0]: https://github.com/s0nderlabs/attn/releases/tag/v0.5.0
[0.4.4]: https://github.com/s0nderlabs/attn/releases/tag/v0.4.4
[0.4.3]: https://github.com/s0nderlabs/attn/releases/tag/v0.4.3
[0.5.4]: https://github.com/s0nderlabs/attn/releases/tag/v0.5.4
[0.4.2]: https://github.com/s0nderlabs/attn/releases/tag/v0.4.2
[0.4.1]: https://github.com/s0nderlabs/attn/releases/tag/v0.4.1
[0.4.0]: https://github.com/s0nderlabs/attn/releases/tag/v0.4.0
[0.3.5]: https://github.com/s0nderlabs/attn/releases/tag/v0.3.5
[0.3.4]: https://github.com/s0nderlabs/attn/releases/tag/v0.3.4
[0.3.3]: https://github.com/s0nderlabs/attn/releases/tag/v0.3.3
[0.3.2]: https://github.com/s0nderlabs/attn/releases/tag/v0.3.2
[0.3.1]: https://github.com/s0nderlabs/attn/releases/tag/v0.3.1
[0.3.0]: https://github.com/s0nderlabs/attn/releases/tag/v0.3.0
[0.2.4]: https://github.com/s0nderlabs/attn/releases/tag/v0.2.4
[0.2.3]: https://github.com/s0nderlabs/attn/releases/tag/v0.2.3
[0.2.2]: https://github.com/s0nderlabs/attn/releases/tag/v0.2.2
[0.2.1]: https://github.com/s0nderlabs/attn/releases/tag/v0.2.1
[0.2.0]: https://github.com/s0nderlabs/attn/releases/tag/v0.2.0
[0.1.0]: https://github.com/s0nderlabs/attn/releases/tag/v0.1.0
