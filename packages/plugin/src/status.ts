import { writeFileSync, unlinkSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { state } from './state.js'
import { getStatusDir, isExternalEnabled } from './env.js'
import { getLocalPeers } from './local.js'
import { isAllMuted } from './history.js'

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let shuttingDown = false
let cachedStatusPath: string | null = null
// Cache of the last-written payload (sans updatedAt) for change detection.
// Suppresses redundant writes during long stretches of unchanged state — e.g.
// the 60s heartbeat ticking while the plugin sits in "reconnecting", or
// both forceCleanupAndReconnect + close handler firing in sequence for the
// same ws. Consumers treat the file as state-snapshot, not a timestamp log.
let lastWrittenPayload: string | null = null

// Walk up the process tree from process.ppid to find this session's Claude
// Code process. Two layouts to handle:
//
//   Interactive: bun(plugin) -> bun(wrapper) -> claude (user's binary, comm=`claude`)
//   Background : bun(plugin) -> bun(wrapper) -> 2.1.139(bg-spare, unique-per-session,
//                comm=`<version>`) -> 2.1.139(pty-host) -> claude(supervisor daemon,
//                comm=`claude`, SHARED across all bg sessions)
//
// The bg-spare process is invoked via the version-pinned binary path
// (/Users/.../share/claude/versions/<X.Y.Z>), so its comm is the version
// string itself. If we only match `claude`, every bg session walks past its
// unique-per-session spare and lands on the shared supervisor daemon — so
// they all stomp on the same `status/<daemon-pid>.json` file. Matching the
// version-named binary as well stops the walker at the bg-spare, which is
// unique per bg session.
//
// Fallback: on Windows (no ps), or if the walker fails, use process.ppid.
function findClaudeCodePid(): number {
  if (process.platform === 'win32') return process.ppid
  try {
    let pid = process.ppid
    for (let depth = 0; depth < 6; depth++) {
      const out = execSync(`ps -o ppid=,comm= -p ${pid}`, { stdio: ['pipe', 'pipe', 'ignore'] })
        .toString()
        .trim()
      const m = out.match(/^\s*(\d+)\s+(.*)$/)
      if (!m) break
      const parentPid = parseInt(m[1], 10)
      const comm = m[2]
      if (/(?:^|\/)claude$/.test(comm) || /(?:^|\/)\d+\.\d+\.\d+$/.test(comm)) return pid
      if (!Number.isFinite(parentPid) || parentPid <= 1) break
      pid = parentPid
    }
  } catch {}
  return process.ppid
}

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
  // Cached — the Claude Code PID doesn't change after process start.
  if (cachedStatusPath) return cachedStatusPath
  // Scope by the Claude Code binary's PID (found by walking past the `bun run`
  // wrapper layer). Each Claude Code instance gets its own status file so a
  // statusline in a window without attn loaded never picks up another window's
  // file. Matches the statusline script's walker for symmetry.
  cachedStatusPath = join(getStatusDir(), `${findClaudeCodePid()}.json`)
  return cachedStatusPath
}

// State-transition write: skip if nothing meaningful changed since last write.
// Prevents double-writes when both forceCleanupAndReconnect and the close
// handler fire for the same ws.
export function writeStatusFile(): void {
  writeStatusFileInternal(false)
}

// Heartbeat write: always refreshes updatedAt so external consumers can use
// it as a liveness signal (>90s stale → plugin dead).
function writeStatusFileLiveness(): void {
  writeStatusFileInternal(true)
}

function writeStatusFileInternal(force: boolean): void {
  // During shutdown, suppress writes. Otherwise the `close` event that fires
  // from ws.close() in cleanup() would re-create the status file after we've
  // already unlinked it, leaving a stale "reconnecting" file on disk.
  if (shuttingDown) return
  try {
    const snapshot = JSON.stringify({
      address: state.address,
      session: state.sessionName ?? 'main',
      sessionType: getSessionType(),
      relay: getRelayStatus(),
      localPeers: getLocalPeers().length,
      presence: state.presence,
      globalMute: isAllMuted(),
    })
    if (!force && snapshot === lastWrittenPayload) return
    lastWrittenPayload = snapshot
    const payload = snapshot.slice(0, -1) + `,"updatedAt":${Date.now()}}`
    writeFileSync(getStatusFilePath(), payload)
  } catch (err) {
    process.stderr.write(`attn: status file write failed: ${err instanceof Error ? err.message : err}\n`)
  }
}

export function startStatusHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  writeStatusFileLiveness()
  heartbeatTimer = setInterval(writeStatusFileLiveness, 60_000)
}

export function stopStatusHeartbeat(): void {
  shuttingDown = true
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  try { unlinkSync(getStatusFilePath()) } catch {}
}
