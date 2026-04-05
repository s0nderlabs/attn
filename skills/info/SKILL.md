---
name: info
description: Show attn agent info — address, relay connection, contacts, pending messages. Use when user asks about their agent identity, connection status, who can message them, or their agent address.
user-invocable: true
allowed-tools:
  - Read
  - mcp__attn__contacts
  - mcp__attn__peers
---

# attn Info

Show the user their agent's current info.

## Steps

1. Read `~/.claude/channels/attn/.env` to check if a key exists (do NOT show the private key — just confirm it exists)

2. The agent's Ethereum address is shown in the MCP server logs on startup (look for `attn: agent address 0x...` in the session). If you know it from context, display it. Otherwise note that it's printed at session start.

3. Relay URL: the default is `wss://attn.s0nderlabs.xyz/ws`. Check if `ATTN_RELAY_URL` is set in the environment or `.env` file.

4. Call the `contacts` tool to get the current contacts list and pending message requests.

5. Call the `peers` tool to see other local sessions.

6. Present a summary:

```
attn Agent Status
─────────────────
Session:  main (or session name if ATTN_SESSION is set)
Address:  0x... (from session context)
Relay:    wss://attn.s0nderlabs.xyz/ws (or "local-only" for derived sessions)
Key file: ~/.claude/channels/attn/.env

Contacts:    N
Pending:     N request(s)
Local peers: N
```

If there are pending requests, list them with their message counts.
If there are local peers, list their names.
