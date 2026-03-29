# Changelog

All notable changes to this project will be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

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

[0.1.0]: https://github.com/s0nderlabs/attn/releases/tag/v0.1.0
