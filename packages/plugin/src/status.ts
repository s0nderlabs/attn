import { writeFileSync, unlinkSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { state } from './state.js'
import { getStatusDir, isExternalEnabled } from './env.js'
import { getLocalPeers } from './local.js'

let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let shuttingDown = false
let cachedStatusPath: string | null = null

// Walk up the process tree from process.ppid to find the Claude Code binary.
// Context: Claude Code spawns MCP servers via `.mcp.json`, and the attn
// plugin is invoked as `bun run --cwd ... start` which spawns the actual
// `bun index.ts` as a child — adding a wrapper layer. So process.ppid
// returns the `bun run` PID, not the claude binary PID. The statusline
// script runs as a direct child of claude (via `bash ~/.claude/statusline.sh`),
// so its $PPID IS the claude binary. For the two sides to find each other's
// file, the plugin needs to walk past the `bun run` wrapper.
//
// Fallback: on Windows (no ps), or if the walker fails, use process.ppid.
// Worst case this re-introduces the v0.5.10 bug but doesn't break anything.
function findClaudeCodePid(): number {
  if (process.platform === 'win32') return process.ppid
  try {
    let pid = process.ppid
    for (let depth = 0; depth < 5; depth++) {
      const out = execSync(`ps -o ppid=,comm= -p ${pid}`, { stdio: ['pipe', 'pipe', 'ignore'] })
        .toString()
        .trim()
      const m = out.match(/^\s*(\d+)\s+(.*)$/)
      if (!m) break
      const parentPid = parseInt(m[1], 10)
      const comm = m[2]
      if (/(?:^|\/)claude$/.test(comm)) return pid
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
