#!/usr/bin/env bun
import { privateKeyToAccount } from 'viem/accounts'
import { parseArgs } from 'util'

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    key: { type: 'string' },
    url: { type: 'string', default: 'ws://localhost:8787/ws' },
    to: { type: 'string' },
    mode: { type: 'string', default: 'listen' },
  },
})

if (!values.key) {
  console.error('Usage: bun test-agent.ts --key 0x... [--url ws://...] [--to 0x...] [--mode listen|send]')
  process.exit(1)
}

const account = privateKeyToAccount(values.key as `0x${string}`)
console.log(`Agent address: ${account.address}`)
console.log(`Mode: ${values.mode}`)
console.log(`Relay: ${values.url}`)
if (values.to) console.log(`Recipient: ${values.to}`)
console.log('---')

let authenticated = false
const wsUrl = `${values.url}?address=${account.address}`
const ws = new WebSocket(wsUrl)

ws.addEventListener('open', () => {
  console.log('Connected to relay')
})

ws.addEventListener('message', async (event) => {
  const msg = JSON.parse(event.data as string)

  switch (msg.type) {
    case 'challenge': {
      console.log(`Challenge received, signing...`)
      const signature = await account.signMessage({ message: msg.nonce })
      ws.send(JSON.stringify({ type: 'auth', address: account.address, signature }))
      break
    }

    case 'auth_ok':
      authenticated = true
      console.log(`Authenticated as ${msg.address}`)
      if (values.mode === 'send' && values.to) {
        console.log('\nType messages to send (one per line):')
      }
      break

    case 'auth_error':
      console.error(`Auth failed: ${msg.error}`)
      process.exit(1)
      break

    case 'message':
      console.log(`\n📨 From ${msg.from}: ${msg.encrypted}`)
      console.log(`   (id: ${msg.id}, ts: ${msg.ts})`)
      // Auto-ack
      ws.send(JSON.stringify({ type: 'ack', id: msg.id }))
      break

    case 'received':
      console.log(`✓ Relay received message ${msg.id}`)
      break

    case 'delivered':
      console.log(`✓✓ Message ${msg.id} delivered to recipient`)
      break

    case 'key_response':
      if (msg.publicKey) {
        console.log(`Key for ${msg.address}: ${msg.publicKey.slice(0, 20)}...`)
      } else {
        console.log(`No key found for ${msg.address}`)
      }
      break

    case 'error':
      console.error(`Error: ${msg.error}`)
      break

    default:
      console.log('Unknown:', msg)
  }
})

ws.addEventListener('close', (event) => {
  console.log(`Disconnected: ${event.code} ${event.reason}`)
  process.exit(0)
})

ws.addEventListener('error', (event) => {
  console.error('WebSocket error:', event)
})

// Read stdin for send mode
if (values.mode === 'send' && values.to) {
  const reader = Bun.stdin.stream().getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  ;(async () => {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()!
      for (const line of lines) {
        const text = line.trim()
        if (!text) continue

        // Wait for auth
        while (!authenticated) await new Promise(r => setTimeout(r, 100))

        if (text.startsWith('key ')) {
          const addr = text.slice(4).trim()
          ws.send(JSON.stringify({ type: 'get_key', address: addr }))
          continue
        }

        const id = crypto.randomUUID()
        ws.send(
          JSON.stringify({
            type: 'message',
            id,
            to: values.to,
            encrypted: text, // plaintext for testing (no ECIES in test-agent)
            signature: '0x00', // dummy signature for testing
          }),
        )
        console.log(`Sent message ${id.slice(0, 8)}...`)
      }
    }
  })()
}
