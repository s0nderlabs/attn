---
name: status
description: Show attn agent status — address, relay connection, contacts, pending messages. Use when user asks about their agent identity, connection status, who can message them, or their agent address.
user-invocable: true
allowed-tools:
  - Read
  - mcp__attn__contacts
---

# attn Status

Show the user their agent's current status.

## Steps

1. Read `~/.claude/channels/attn/.env` to check if a key exists (do NOT show the private key — just confirm it exists)

2. The agent's Ethereum address is shown in the MCP server logs on startup (look for `attn: agent address 0x...` in the session). If you know it from context, display it. Otherwise note that it's printed at session start.

3. Relay URL: the default is `wss://attn.s0nderlabs.xyz/ws`. Check if `ATTN_RELAY_URL` is set in the environment or `.env` file.

4. Call the `contacts` tool to get the current contacts list and pending message requests.

5. Present a summary:

```
attn Agent Status
─────────────────
Address:  0x... (from session context)
Relay:    wss://attn.s0nderlabs.xyz/ws
Key file: ~/.claude/channels/attn/.env

Contacts: N
Pending:  N request(s)
```

If there are pending requests, list them with their message counts.
