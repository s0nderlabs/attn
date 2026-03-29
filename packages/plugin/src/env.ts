import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { STATE_DIR_NAME, ENV_FILE_NAME, DEFAULT_RELAY_URL } from '@attn/shared/constants'

export function getStateDir(): string {
  return process.env.ATTN_STATE_DIR ?? join(homedir(), '.claude', 'channels', STATE_DIR_NAME)
}

export function getRelayUrl(): string {
  return process.env.ATTN_RELAY_URL ?? DEFAULT_RELAY_URL
}

export function loadEnvFile(): void {
  const envFile = join(getStateDir(), ENV_FILE_NAME)
  try {
    chmodSync(envFile, 0o600)
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
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
  writeFileSync(join(stateDir, ENV_FILE_NAME), `ATTN_PRIVATE_KEY=${privateKey}\n`, { mode: 0o600 })

  process.stderr.write(`attn: Generated new agent identity\n`)
  process.stderr.write(`attn: Address: ${account.address}\n`)
  process.stderr.write(`attn: Key stored at ${join(stateDir, ENV_FILE_NAME)}\n`)

  return privateKey
}
