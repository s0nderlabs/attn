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

  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      address TEXT PRIMARY KEY,
      name TEXT,
      added_at TEXT NOT NULL
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS pending (
      id TEXT PRIMARY KEY,
      from_address TEXT NOT NULL,
      plaintext TEXT NOT NULL,
      ts INTEGER NOT NULL,
      notified INTEGER DEFAULT 0
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_from ON pending(from_address)`)

  db.exec(`
    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY,
      to_address TEXT NOT NULL,
      encrypted TEXT NOT NULL,
      signature TEXT NOT NULL,
      ts INTEGER NOT NULL,
      attempts INTEGER DEFAULT 0
    )
  `)

  return db
}

// --- Messages ---

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

// --- Contacts ---

export function isContact(address: string): boolean {
  const d = initDb()
  const row = d
    .query<{ address: string }, [string]>(`SELECT address FROM contacts WHERE address = ?`)
    .get(address.toLowerCase())
  return !!row
}

export function addContact(address: string, name?: string): void {
  const d = initDb()
  d.run(
    `INSERT INTO contacts (address, name, added_at) VALUES (?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET name = COALESCE(excluded.name, contacts.name)`,
    [address.toLowerCase(), name ?? null, new Date().toISOString()],
  )
}

export function getContactName(address: string): string | null {
  const d = initDb()
  const row = d
    .query<{ name: string | null }, [string]>(`SELECT name FROM contacts WHERE address = ?`)
    .get(address.toLowerCase())
  return row?.name ?? null
}

export function getContacts(): Array<{ address: string; name: string | null; added_at: string }> {
  const d = initDb()
  return d
    .query<{ address: string; name: string | null; added_at: string }, []>(
      `SELECT address, name, added_at FROM contacts ORDER BY added_at DESC`,
    )
    .all()
}

export function removeContact(address: string): void {
  const d = initDb()
  d.run(`DELETE FROM contacts WHERE address = ?`, [address.toLowerCase()])
}

// --- Pending ---

export function savePending(msg: {
  id: string
  from_address: string
  plaintext: string
  ts: number
}): void {
  const d = initDb()
  d.run(
    `INSERT OR IGNORE INTO pending (id, from_address, plaintext, ts) VALUES (?, ?, ?, ?)`,
    [msg.id, msg.from_address.toLowerCase(), msg.plaintext, msg.ts],
  )
}

export function getPendingCount(from_address: string): number {
  const d = initDb()
  const row = d
    .query<{ count: number }, [string]>(
      `SELECT COUNT(*) as count FROM pending WHERE from_address = ?`,
    )
    .get(from_address.toLowerCase())
  return row?.count ?? 0
}

export function hasPendingNotified(from_address: string): boolean {
  const d = initDb()
  const row = d
    .query<{ notified: number }, [string]>(
      `SELECT notified FROM pending WHERE from_address = ? AND notified = 1 LIMIT 1`,
    )
    .get(from_address.toLowerCase())
  return !!row
}

export function markPendingNotified(from_address: string): void {
  const d = initDb()
  d.run(`UPDATE pending SET notified = 1 WHERE from_address = ?`, [from_address.toLowerCase()])
}

export function flushPending(
  from_address: string,
): Array<{ id: string; plaintext: string; ts: number }> {
  const d = initDb()
  const rows = d
    .query<{ id: string; plaintext: string; ts: number }, [string]>(
      `SELECT id, plaintext, ts FROM pending WHERE from_address = ? ORDER BY ts ASC`,
    )
    .all(from_address.toLowerCase())
  if (rows.length > 0) {
    d.run(`DELETE FROM pending WHERE from_address = ?`, [from_address.toLowerCase()])
  }
  return rows
}

export function getPendingSenders(): Array<{ from_address: string; count: number }> {
  const d = initDb()
  return d
    .query<{ from_address: string; count: number }, []>(
      `SELECT from_address, COUNT(*) as count FROM pending GROUP BY from_address ORDER BY count DESC`,
    )
    .all()
}

// --- Outbox ---

export function saveOutbox(msg: {
  id: string
  to_address: string
  encrypted: string
  signature: string
  ts: number
}): void {
  const d = initDb()
  d.run(
    `INSERT OR IGNORE INTO outbox (id, to_address, encrypted, signature, ts) VALUES (?, ?, ?, ?, ?)`,
    [msg.id, msg.to_address.toLowerCase(), msg.encrypted, msg.signature, msg.ts],
  )
}

export function getOutbox(): Array<{
  id: string
  to_address: string
  encrypted: string
  signature: string
  ts: number
  attempts: number
}> {
  const d = initDb()
  return d
    .query<
      { id: string; to_address: string; encrypted: string; signature: string; ts: number; attempts: number },
      []
    >(`SELECT id, to_address, encrypted, signature, ts, attempts FROM outbox ORDER BY ts ASC`)
    .all()
}

export function deleteOutbox(id: string): void {
  const d = initDb()
  d.run(`DELETE FROM outbox WHERE id = ?`, [id])
}

export function incrementOutboxAttempts(id: string): void {
  const d = initDb()
  d.run(`UPDATE outbox SET attempts = attempts + 1 WHERE id = ?`, [id])
}
