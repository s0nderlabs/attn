import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { STATE_DIR_NAME, ENV_FILE_NAME, DEFAULT_RELAY_URL, PEERS_DIR_NAME, SESSIONS_DIR_NAME } from '@attn/shared/constants'

export function getStateDir(): string {
  return process.env.ATTN_STATE_DIR ?? join(homedir(), '.claude', 'channels', STATE_DIR_NAME)
}

export function getRelayUrl(): string {
  return process.env.ATTN_RELAY_URL ?? DEFAULT_RELAY_URL
}

export function getRelayHttpUrl(): string {
  const wsUrl = getRelayUrl()
  return wsUrl.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/ws$/, '')
}

export function getInboxDir(): string {
  const dir = join(getStateDir(), 'inbox')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function getSessionName(): string | null {
  const session = process.env.ATTN_SESSION
  if (!session || session === 'main') return null
  if (session === 'all') {
    throw new Error('"all" is reserved for local broadcast. Use a different ATTN_SESSION name.')
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(session)) {
    throw new Error(`Invalid ATTN_SESSION name "${session}". Use only letters, numbers, hyphens, underscores.`)
  }
  return session
}

export function isExternalEnabled(): boolean {
  return process.env.ATTN_EXTERNAL === '1'
}

export function getPeersDir(): string {
  if (process.env.ATTN_STATE_DIR) return join(process.env.ATTN_STATE_DIR, PEERS_DIR_NAME)
  return join(homedir(), '.claude', 'channels', STATE_DIR_NAME, PEERS_DIR_NAME)
}

export function getSessionDbDir(sessionName: string): string {
  return join(getStateDir(), SESSIONS_DIR_NAME, sessionName)
}

export function loadEnvFile(): void {
  const envFile = join(getStateDir(), ENV_FILE_NAME)
  try {
    try { chmodSync(envFile, 0o600) } catch {} // no-op on Windows
    for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^(\w+)=(.*)$/)
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
    }
  } catch {}
}

export function resolvePrivateKey(): `0x${string}` {
  // 1. Check env var
  if (process.env.ATTN_PRIVATE_KEY) {
    return process.env.ATTN_PRIVATE_KEY as `0x${string}`
  }

  // 2. Load from .env file
  loadEnvFile()
  if (process.env.ATTN_PRIVATE_KEY) {
    return process.env.ATTN_PRIVATE_KEY as `0x${string}`
  }

  // 3. Generate new key
  const privateKey = generatePrivateKey()
  const account = privateKeyToAccount(privateKey)
  const stateDir = getStateDir()

  mkdirSync(stateDir, { recursive: true })
  const envPath = join(stateDir, ENV_FILE_NAME)
  writeFileSync(envPath, `ATTN_PRIVATE_KEY=${privateKey}\n`)
  try { chmodSync(envPath, 0o600) } catch {} // no-op on Windows

  process.stderr.write(`attn: Generated new agent identity\n`)
  process.stderr.write(`attn: Address: ${account.address}\n`)
  process.stderr.write(`attn: Key stored at ${join(stateDir, ENV_FILE_NAME)}\n`)

  return privateKey
}
