import { Database } from 'bun:sqlite'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { getStateDir } from './env.js'
import { HISTORY_DB_NAME } from '@attn/shared/constants'

let db: Database | null = null

export function initDb(): Database {
  if (db) return db

  const stateDir = getStateDir()
  mkdirSync(stateDir, { recursive: true })

  db = new Database(join(stateDir, HISTORY_DB_NAME))
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      peer TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
      content TEXT NOT NULL,
      ts TEXT NOT NULL
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_peer_ts ON messages(peer, ts DESC)`)
  return db
}

export function saveMessage(msg: {
  id: string
  peer: string
  direction: 'inbound' | 'outbound'
  content: string
  ts: string
}): void {
  const d = initDb()
  d.run(
    `INSERT OR IGNORE INTO messages (id, peer, direction, content, ts) VALUES (?, ?, ?, ?, ?)`,
    [msg.id, msg.peer.toLowerCase(), msg.direction, msg.content, msg.ts],
  )
}

export function getHistory(
  peer: string,
  limit: number = 20,
): Array<{ id: string; peer: string; direction: string; content: string; ts: string }> {
  const d = initDb()
  return d
    .query<
      { id: string; peer: string; direction: string; content: string; ts: string },
      [string, number]
    >(`SELECT id, peer, direction, content, ts FROM messages WHERE peer = ? ORDER BY ts DESC LIMIT ?`)
    .all(peer.toLowerCase(), limit)
    .reverse()
}
