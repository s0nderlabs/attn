import net from 'node:net'
import { mkdirSync, writeFileSync, unlinkSync, readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { getPeersDir } from './env.js'
import { state } from './state.js'

// --- Types ---

export interface PeerInfo {
  name: string
  address: string
  pid: number
  workdir: string
  startedAt: string
}

export interface LocalMessage {
  from: string
  fromAddress: string
  text: string
  ts: number
  group?: string
  reaction_for?: string
}

// --- Paths ---

function getSocketPath(name: string): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\attn-${name}`
  }
  return join(getPeersDir(), `${name}.sock`)
}

function getMetadataPath(name: string): string {
  return join(getPeersDir(), `${name}.json`)
}

// --- Peer metadata ---

export function writePeerInfo(name: string, address: string): void {
  const peersDir = getPeersDir()
  mkdirSync(peersDir, { recursive: true })

  const info: PeerInfo = {
    name,
    address,
    pid: process.pid,
    workdir: process.cwd(),
    startedAt: new Date().toISOString(),
  }
  writeFileSync(getMetadataPath(name), JSON.stringify(info, null, 2))
}

export function removePeerInfo(name: string): void {
  try { unlinkSync(getMetadataPath(name)) } catch {}
  try { unlinkSync(getSocketPath(name)) } catch {}
}

// --- Liveness ---

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// --- Discovery ---

export function getLocalPeers(): PeerInfo[] {
  const peersDir = getPeersDir()
  if (!existsSync(peersDir)) return []

  const peers: PeerInfo[] = []
  const files = readdirSync(peersDir).filter(f => f.endsWith('.json'))

  for (const file of files) {
    try {
      const raw = readFileSync(join(peersDir, file), 'utf8')
      const info: PeerInfo = JSON.parse(raw)
      if (info.pid === process.pid) continue
      if (isProcessRunning(info.pid)) {
        peers.push(info)
      } else {
        removePeerInfo(info.name)
      }
    } catch {}
  }
  return peers
}

export function getLocalPeer(name: string): PeerInfo | null {
  const metaPath = getMetadataPath(name)
  if (!existsSync(metaPath)) return null

  try {
    const info: PeerInfo = JSON.parse(readFileSync(metaPath, 'utf8'))
    if (info.pid === process.pid) return null
    if (!isProcessRunning(info.pid)) {
      removePeerInfo(name)
      return null
    }
    return info
  } catch {
    return null
  }
}

// --- Duplicate check ---

export function checkDuplicateSession(name: string): void {
  const metaPath = getMetadataPath(name)
  if (!existsSync(metaPath)) return

  try {
    const info: PeerInfo = JSON.parse(readFileSync(metaPath, 'utf8'))
    if (isProcessRunning(info.pid)) {
      throw new Error(`Session "${name}" is already running (PID ${info.pid}). Use a different ATTN_SESSION name.`)
    }
    removePeerInfo(name)
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Session')) throw err
    removePeerInfo(name)
  }
}

// --- Socket server ---

type OnLocalMessage = (msg: LocalMessage) => void

export function startLocalServer(name: string, onMessage: OnLocalMessage): net.Server {
  const sockPath = getSocketPath(name)

  // Clean up stale socket file (non-Windows)
  if (process.platform !== 'win32') {
    try { unlinkSync(sockPath) } catch {}
  }

  const server = net.createServer((conn) => {
    let buffer = ''
    conn.on('error', () => {})
    conn.on('data', (chunk) => {
      buffer += chunk.toString()
      let idx: number
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (line.trim()) {
          try {
            onMessage(JSON.parse(line) as LocalMessage)
          } catch (err) {
            process.stderr.write(`attn: invalid local message: ${err}\n`)
          }
        }
      }
    })
  })

  server.listen(sockPath, () => {
    process.stderr.write(`attn: local server listening\n`)
  })

  server.on('error', (err) => {
    process.stderr.write(`attn: local server error: ${err.message}\n`)
  })

  return server
}

// --- Socket client ---

export function sendLocal(peerName: string, message: LocalMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    const sockPath = getSocketPath(peerName)
    const conn = net.createConnection(sockPath, () => {
      conn.write(JSON.stringify(message) + '\n')
      conn.end()
      resolve()
    })
    conn.on('error', (err) => {
      reject(new Error(`Failed to send to ${peerName}: ${err.message}`))
    })
    conn.setTimeout(5000, () => {
      conn.destroy()
      reject(new Error(`Timeout sending to ${peerName}`))
    })
  })
}

// --- Cleanup ---

export function cleanupLocal(name: string): void {
  if (state.localServer) {
    try { state.localServer.close() } catch {}
    state.localServer = null
  }
  removePeerInfo(name)
}
