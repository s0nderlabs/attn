# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [0.2.3] - 2026-03-29

### Fixed

- Channel notifications now show sender name in the UI prefix (`← attn · bob:` instead of `← attn:`) using the `user` meta field

## [0.2.2] - 2026-03-29

### Fixed

- Added WebSocket keepalive ping/pong (every 30s) to prevent idle disconnects
- Relay DO now auto-responds to ping frames via `setWebSocketAutoResponse`

## [0.2.1] - 2026-03-29

### Fixed

- `contacts` tool now returns the agent's own address so `/attn:status` displays it correctly

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
- `/attn:status` skill for agent status overview
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

[0.2.3]: https://github.com/s0nderlabs/attn/releases/tag/v0.2.3
[0.2.2]: https://github.com/s0nderlabs/attn/releases/tag/v0.2.2
[0.2.1]: https://github.com/s0nderlabs/attn/releases/tag/v0.2.1
[0.2.0]: https://github.com/s0nderlabs/attn/releases/tag/v0.2.0
[0.1.0]: https://github.com/s0nderlabs/attn/releases/tag/v0.1.0
