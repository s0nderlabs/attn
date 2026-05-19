#!/usr/bin/env bun
// Concurrent-safe self-healing bootstrap for the attn plugin.
//
// Background. ~/.claude/plugins/cache/.../attn/ is shared by every Claude
// Code session that loads -attn. With the old start script, simultaneous
// sessions ran `bun install` in parallel against the same node_modules
// and produced a partial state: package directories present, but their
// dist/cjs and dist/esm subdirs missing (mid-extraction overwrite by a
// peer process). `bun install` then no-ops on the next run because the
// lockfile matches what's in .bun/, so the broken state is permanent
// until the directory is nuked.
//
// This bootstrap fixes both halves:
//
//   1. PROBE not GUESS. Health is verified by actually importing the
//      modules the plugin needs (viem, eciesjs, @modelcontextprotocol/sdk
//      subpaths). The abitype failure that caused the original bug
//      manifests as an import error here, so we catch it.
//
//   2. SERIALIZE on heal. When the probe fails we acquire an atomic-mkdir
//      lock that reclaims itself from dead PIDs / stale timestamps, then
//      nuke + reinstall under the lock. Peers wait, retry the fast path,
//      and find healthy state without redoing the work.
//
//   3. MARKER for fast path. After a probe-verified install we write
//      node_modules/.attn-install-ok. Subsequent starts see the marker
//      and skip the probe entirely (zero cost). The marker is wiped by
//      the nuke step, so it cannot survive a real install failure.
//
// Uses only Bun built-ins so it runs even when node_modules is empty.

import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = import.meta.dir
const NM = join(ROOT, 'node_modules')
const PLUGIN_DIR = join(ROOT, 'packages/plugin')
const LOCK_DIR = join(ROOT, '.attn-install.lock')
const LOCK_PID = join(LOCK_DIR, 'pid')
const LOCK_TS = join(LOCK_DIR, 'ts')
const HEALTH_MARKER = join(NM, '.attn-install-ok')

const LOCK_WAIT_TIMEOUT_MS = 180_000   // 3 min wait for a peer installer
const LOCK_STALE_MS = 10 * 60_000      // 10 min: any lock older than this is abandoned
const INSTALL_RETRIES = 2
const INSTALL_TIMEOUT_MS = 300_000     // 5 min per attempt — bun install on a cold cache
const PROBE_TIMEOUT_MS = 30_000

// The plugin's actual import surface. If any of these fails to resolve,
// the plugin will crash, so they're the right canaries.
const PROBE_IMPORTS = [
  'viem',
  'eciesjs',
  '@modelcontextprotocol/sdk/server/index.js',
  '@modelcontextprotocol/sdk/server/stdio.js',
  '@modelcontextprotocol/sdk/types.js',
]

function log(msg: string) {
  // stderr only. stdout is the MCP JSON-RPC pipe and contamination here
  // would crash the parent claude with a JSON parse error.
  process.stderr.write(`attn[bootstrap]: ${msg}\n`)
}

function pathExists(p: string): boolean {
  try { lstatSync(p); return true } catch { return false }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    // EPERM => process exists, we just can't signal it.
    return e?.code === 'EPERM'
  }
}

function readLockMeta(): { pid: number | null; ts: number | null } {
  let pid: number | null = null
  let ts: number | null = null
  try { pid = Number.parseInt(readFileSync(LOCK_PID, 'utf8').trim(), 10) } catch {}
  try { ts = Number.parseInt(readFileSync(LOCK_TS, 'utf8').trim(), 10) } catch {}
  if (ts == null) {
    try { ts = statSync(LOCK_DIR).mtimeMs } catch {}
  }
  return { pid, ts }
}

function lockIsStale(): boolean {
  const { pid, ts } = readLockMeta()
  if (pid != null && !isPidAlive(pid)) return true
  if (ts != null && Date.now() - ts > LOCK_STALE_MS) return true
  return false
}

async function acquireLock(): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < LOCK_WAIT_TIMEOUT_MS) {
    try {
      mkdirSync(LOCK_DIR)
      writeFileSync(LOCK_PID, String(process.pid))
      writeFileSync(LOCK_TS, String(Date.now()))
      return true
    } catch (e: any) {
      if (e.code !== 'EEXIST') {
        log(`lock mkdir failed (${e.code ?? e.message}); aborting acquire`)
        return false
      }
      if (lockIsStale()) {
        log('reclaiming stale install lock')
        try { rmSync(LOCK_DIR, { recursive: true, force: true }) } catch {}
        continue
      }
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  return false
}

function releaseLock() {
  try {
    const { pid } = readLockMeta()
    if (pid === process.pid) {
      rmSync(LOCK_DIR, { recursive: true, force: true })
    }
  } catch {}
}

function probeImports(): boolean {
  const code = `Promise.all(${JSON.stringify(PROBE_IMPORTS)}.map((p) => import(p)))` +
    `.then(() => process.exit(0))` +
    `.catch((e) => { process.stderr.write('probe failed: ' + (e && e.message ? e.message : e) + '\\n'); process.exit(1) })`
  const r = spawnSync('bun', ['-e', code], {
    cwd: PLUGIN_DIR,
    stdio: ['ignore', 'ignore', 'pipe'],
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
  })
  if (r.status !== 0) {
    if (r.stderr) process.stderr.write(`attn[bootstrap probe]: ${r.stderr.trim()}\n`)
    return false
  }
  return true
}

function nuke() {
  try { rmSync(NM, { recursive: true, force: true }) } catch {}
  try {
    for (const pkg of readdirSync(join(ROOT, 'packages'))) {
      try { rmSync(join(ROOT, 'packages', pkg, 'node_modules'), { recursive: true, force: true }) } catch {}
    }
  } catch {}
}

function bunInstall(useCopyfile: boolean): boolean {
  const args = ['install', '--no-summary']
  if (useCopyfile) args.push('--backend=copyfile')
  const r = spawnSync('bun', args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: INSTALL_TIMEOUT_MS,
  })
  if (r.stdout?.trim()) process.stderr.write(`[bun install stdout]\n${r.stdout}\n`)
  if (r.stderr?.trim()) process.stderr.write(`[bun install stderr]\n${r.stderr}\n`)
  if (r.error) {
    log(`bun install errored: ${r.error.message}`)
    return false
  }
  if (r.status !== 0) {
    log(`bun install exited ${r.status} (signal=${r.signal})`)
    return false
  }
  return true
}

function writeMarker() {
  try {
    writeFileSync(HEALTH_MARKER, JSON.stringify({ ts: Date.now(), pid: process.pid }))
  } catch (e: any) {
    log(`could not write health marker: ${e.message}`)
  }
}

async function ensureInstalled(): Promise<boolean> {
  // Fast path: marker present means the prior install was probe-verified.
  // The marker lives inside node_modules so a nuke wipes it automatically.
  if (existsSync(HEALTH_MARKER)) return true

  log('no health marker — verifying install with import probe')
  if (probeImports()) {
    writeMarker()
    log('install verified healthy')
    return true
  }

  log('probe failed — acquiring install lock')
  if (!(await acquireLock())) {
    log('lock timeout — falling back to one last probe')
    return probeImports()
  }

  try {
    // Peer may have healed while we waited.
    if (existsSync(HEALTH_MARKER)) {
      log('healed by concurrent installer')
      return true
    }
    if (probeImports()) {
      writeMarker()
      log('healed by concurrent installer')
      return true
    }

    for (let attempt = 1; attempt <= INSTALL_RETRIES; attempt++) {
      log(`install attempt ${attempt}/${INSTALL_RETRIES}: nuke + bun install --backend=copyfile`)
      nuke()
      if (!bunInstall(true)) {
        log(`bun install failed on attempt ${attempt}`)
        continue
      }
      if (probeImports()) {
        writeMarker()
        log(`install healthy after attempt ${attempt}`)
        return true
      }
      log(`attempt ${attempt} install completed but probe still failing`)
    }
    log('install failed probe after all retries')
    return false
  } finally {
    releaseLock()
  }
}

// Best-effort stale cleanup. The .in_use/ and ~/.claude/channels/attn/status/
// dirs accumulate per-PID entries that never get cleaned up after the
// parent dies. Non-fatal: any failure here is swallowed.
function sweepStale() {
  const sweep = (dir: string, toPid: (f: string) => number | null) => {
    if (!pathExists(dir)) return
    let removed = 0
    try {
      for (const f of readdirSync(dir)) {
        const pid = toPid(f)
        if (pid != null && !isPidAlive(pid)) {
          try { rmSync(join(dir, f), { force: true, recursive: true }); removed++ } catch {}
        }
      }
    } catch {}
    if (removed > 0) log(`swept ${removed} stale entries from ${dir}`)
  }
  sweep(join(ROOT, '.in_use'), (f) => {
    const n = Number.parseInt(f, 10)
    return Number.isFinite(n) ? n : null
  })
  const homeStatusDir = join(process.env.HOME ?? '', '.claude/channels/attn/status')
  sweep(homeStatusDir, (f) => {
    const m = f.match(/^(\d+)\.json$/)
    return m ? Number.parseInt(m[1]!, 10) : null
  })
}

// Track whether the slow (install) path ran. The sweep is best-effort
// maintenance, not load-bearing — only run it when we already paid the
// cost of an install so the fast path stays sub-100ms.
let didInstall = false
const installed = existsSync(HEALTH_MARKER)
const ok = await ensureInstalled()
didInstall = ok && !installed
if (didInstall) sweepStale()
if (!ok) {
  log('giving up; plugin start will fail downstream')
  process.exit(1)
}
