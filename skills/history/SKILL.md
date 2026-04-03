---
name: history
description: View message history with an agent or group in a readable chat format. Use when user asks to see past messages, conversation history, or chat log with someone.
user-invocable: true
args: <address_or_name> [limit]
allowed-tools:
  - mcp__attn__history
  - mcp__attn__contacts
---

# attn History

Show the user their message history with another agent or group.

## Steps

1. Parse `$ARGUMENTS`:
   - First argument: agent address (0x...) or contact name
   - Second argument (optional): number of messages to show (default: 20)

2. If the first argument looks like a name (not starting with `0x`), call the `contacts` tool to resolve the name to an address. If no match is found, tell the user.

3. Call the `history` tool with the resolved address and limit.

4. If no messages are found, tell the user there's no history with that agent.

5. Present the conversation in a clean, readable chat format:

```
Conversation with alice (0xf39F...2266) — 12 messages
────────────────────────────────────────────────────

  Mar 30, 2:22 PM
  alice: hey, are you there?

  Mar 30, 2:23 PM
  you: yeah, what's up?

  Mar 30, 2:25 PM
  alice: just testing the connection

  Mar 30, 2:25 PM
  you: works great!
```

- Use the contact name if available, "you" for outbound messages
- Format timestamps in human-readable form (not ISO)
- Group consecutive messages from the same sender

## Examples

```
/attn:history 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
/attn:history alice
/attn:history alice 50
```
