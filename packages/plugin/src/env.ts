import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { STATE_DIR_NAME, ENV_FILE_NAME, DEFAULT_RELAY_URL, PEERS_DIR_NAME, SESSIONS_DIR_NAME } from '@attn/shared/constants'
import type { PresenceState } from './state.js'

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

export function getStatusDir(): string {
  const dir = join(getStateDir(), 'status')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function isBgSession(): boolean {
  // Claude Code's supervisor sets CLAUDE_CODE_SESSION_KIND="bg" on every bg
  // session spawn (verified in claude binary v2.1.139). CLAUDE_JOB_DIR is the
  // companion var that gives us the job id.
  return process.env.CLAUDE_CODE_SESSION_KIND === 'bg' || Boolean(process.env.CLAUDE_JOB_DIR)
}

function deriveBgSessionName(): string | null {
  const jobDir = process.env.CLAUDE_JOB_DIR
  if (!jobDir) return null

  // Prefer the user-facing name from the supervisor's state.json (e.g.
  // "attn-local", "anima-testing"). CLAUDE_CODE_SESSION_NAME env var is
  // unreliable: empty when the user renames via /agents Ctrl+R, since the
  // supervisor seeds it once at spawn.
  try {
    const data = JSON.parse(readFileSync(join(jobDir, 'state.json'), 'utf8')) as { name?: string }
    if (typeof data?.name === 'string') {
      const sanitized = data.name
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-+/g, '-')
        .slice(0, 48)
      // Skip names that would collide with reserved/interactive identifiers.
      if (sanitized.length >= 2 && sanitized !== 'main' && sanitized !== 'all') {
        return sanitized
      }
    }
  } catch {}

  return `bg-${basename(jobDir).slice(0, 8)}`
}

export function getSessionName(): string | null {
  const session = process.env.ATTN_SESSION

  // Bg context with no explicit ATTN_SESSION (or "main") auto-derives a unique
  // name. The supervisor's spare-pool freezes its env at supervisor-start, so
  // caller-set ATTN_SESSION never reaches the dispatched session. Without this
  // override every bg session would default to "main" and collide with the
  // interactive main session, killing the plugin on duplicate-session check.
  if (isBgSession() && (!session || session === 'main')) {
    const derived = deriveBgSessionName()
    if (derived) return derived
  }

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

function getPresenceFilePath(): string {
  const session = getSessionName()
  const dir = session ? getSessionDbDir(session) : getStateDir()
  mkdirSync(dir, { recursive: true })
  return join(dir, 'presence.json')
}

export function loadPresence(): { state: PresenceState; message: string | null; setAt: number } | null {
  const path = getPresenceFilePath()
  if (!existsSync(path)) return null
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as { state: PresenceState; message: string | null; setAt: number }
    if (data.state !== 'online' && data.state !== 'away') return null
    return data
  } catch {
    return null
  }
}

export function savePresence(state: PresenceState, message: string | null): void {
  const path = getPresenceFilePath()
  const data = { state, message, setAt: Date.now() }
  writeFileSync(path, JSON.stringify(data))
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
