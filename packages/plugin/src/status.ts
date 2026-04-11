import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { state } from './state.js'
import { getStatusDir, isExternalEnabled } from './env.js'
import { getLocalPeers } from './local.js'

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let shuttingDown = false
let cachedStatusPath: string | null = null

export type SessionType = 'main' | 'local' | 'external'
export type RelayStatus = 'connected' | 'connecting' | 'reconnecting' | 'n/a'

export function getSessionType(): SessionType {
  if (!state.sessionName) return 'main'
  return isExternalEnabled() ? 'external' : 'local'
}

// Single source of truth for "can I actually talk to the relay right now".
// Every call site that previously checked `state.ws && state.authenticated`
// should use this instead — it adds the readyState check that the ad-hoc
// checks were missing.
export function isRelayReady(): boolean {
  return (
    state.ws !== null &&
    state.ws.readyState === WebSocket.OPEN &&
    state.authenticated
  )
}

export function getRelayStatus(): RelayStatus {
  // Local-only derived sessions never connect to the relay — not an error state.
  if (getSessionType() === 'local') return 'n/a'
  if (isRelayReady()) return 'connected'
  if (state.ws !== null && state.ws.readyState === WebSocket.CONNECTING) return 'connecting'
  return 'reconnecting'
}

function getStatusFilePath(): string {
  // Cached — status dir is created once in startStatusHeartbeat(), and the
  // session name can't change after process start, so neither can the path.
  if (cachedStatusPath) return cachedStatusPath
  const session = state.sessionName ?? 'main'
  cachedStatusPath = join(getStatusDir(), `${session}.json`)
  return cachedStatusPath
}

export function writeStatusFile(): void {
  // During shutdown, suppress writes. Otherwise the `close` event that fires
  // from ws.close() in cleanup() would re-create the status file after we've
  // already unlinked it, leaving a stale "reconnecting" file on disk.
  if (shuttingDown) return
  try {
    const payload = {
      address: state.address,
      session: state.sessionName ?? 'main',
      sessionType: getSessionType(),
      relay: getRelayStatus(),
      localPeers: getLocalPeers().length,
      updatedAt: Date.now(),
    }
    writeFileSync(getStatusFilePath(), JSON.stringify(payload))
  } catch (err) {
    process.stderr.write(`attn: status file write failed: ${err instanceof Error ? err.message : err}\n`)
  }
}

export function startStatusHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  writeStatusFile()
  heartbeatTimer = setInterval(writeStatusFile, 60_000)
}

export function stopStatusHeartbeat(): void {
  shuttingDown = true
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  try { unlinkSync(getStatusFilePath()) } catch {}
}
