import { Database } from 'bun:sqlite'
import { join } from 'path'
import { mkdirSync } from 'fs'
import { getStateDir, getSessionName, getSessionDbDir } from './env.js'
import { HISTORY_DB_NAME } from '@attn/shared/constants'

let db: Database | null = null

export function initDb(): Database {
  if (db) return db

  const sessionName = getSessionName()
  const dbDir = sessionName ? getSessionDbDir(sessionName) : getStateDir()
  mkdirSync(dbDir, { recursive: true })

  db = new Database(join(dbDir, HISTORY_DB_NAME))

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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_dir_ts ON messages(direction, ts)`)

  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      address TEXT PRIMARY KEY,
      name TEXT,
      added_at TEXT NOT NULL
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS blocked (
      address TEXT PRIMARY KEY,
      blocked_at TEXT NOT NULL
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

  db.exec(`
    CREATE TABLE IF NOT EXISTS key_cache (
      address TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS group_members (
      group_id TEXT NOT NULL,
      address TEXT NOT NULL,
      name TEXT,
      PRIMARY KEY (group_id, address)
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS group_invites (
      group_id TEXT PRIMARY KEY,
      group_name TEXT NOT NULL,
      from_address TEXT NOT NULL,
      members_json TEXT NOT NULL,
      ts INTEGER NOT NULL
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS reactions (
      message_id TEXT NOT NULL,
      from_address TEXT NOT NULL,
      emoji TEXT NOT NULL,
      ts TEXT NOT NULL,
      PRIMARY KEY (message_id, from_address)
    )
  `)

  // Mutes: if an older schema (without 'all') already exists, drop it —
  // safe because the feature hasn't shipped yet and the table only holds
  // runtime-configurable state.
  const oldMutes = db
    .query<{ sql: string | null }, []>(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mutes'`)
    .get()
  if (oldMutes?.sql && !oldMutes.sql.includes("'all'")) {
    db.exec(`DROP TABLE mutes`)
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS mutes (
      target TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('agent', 'group', 'all')),
      until INTEGER,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (target, kind)
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

export function updateContactName(address: string, name: string | null): void {
  const d = initDb()
  d.run(`UPDATE contacts SET name = ? WHERE address = ?`, [name, address.toLowerCase()])
}

export function getContactName(address: string): string | null {
  const d = initDb()
  const row = d
    .query<{ name: string | null }, [string]>(`SELECT name FROM contacts WHERE address = ?`)
    .get(address.toLowerCase())
  return row?.name ?? null
}

export function getContactByName(name: string): string | null {
  const d = initDb()
  const row = d
    .query<{ address: string }, [string]>(`SELECT address FROM contacts WHERE lower(name) = ? LIMIT 1`)
    .get(name.toLowerCase())
  return row?.address ?? null
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

// --- Blocked ---

export function blockContact(address: string): void {
  const d = initDb()
  d.run(
    `INSERT OR IGNORE INTO blocked (address, blocked_at) VALUES (?, ?)`,
    [address.toLowerCase(), new Date().toISOString()],
  )
  d.run(`DELETE FROM contacts WHERE address = ?`, [address.toLowerCase()])
  d.run(`DELETE FROM pending WHERE from_address = ?`, [address.toLowerCase()])
}

export function unblockContact(address: string): void {
  const d = initDb()
  d.run(`DELETE FROM blocked WHERE address = ?`, [address.toLowerCase()])
}

export function isBlocked(address: string): boolean {
  const d = initDb()
  const row = d
    .query<{ address: string }, [string]>(`SELECT address FROM blocked WHERE address = ?`)
    .get(address.toLowerCase())
  return !!row
}

export function getBlocked(): Array<{ address: string; blocked_at: string }> {
  const d = initDb()
  return d
    .query<{ address: string; blocked_at: string }, []>(
      `SELECT address, blocked_at FROM blocked ORDER BY blocked_at DESC`,
    )
    .all()
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

export function expirePending(maxAgeMs: number): number {
  const d = initDb()
  const cutoff = Date.now() - maxAgeMs
  const result = d.run(`DELETE FROM pending WHERE ts < ?`, [cutoff])
  return result.changes
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

// --- Key Cache ---

export function saveKeyCache(address: string, publicKey: string): void {
  const d = initDb()
  d.run(
    `INSERT INTO key_cache (address, public_key, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET public_key = excluded.public_key, updated_at = excluded.updated_at`,
    [address.toLowerCase(), publicKey, new Date().toISOString()],
  )
}

export function getKeyCache(address: string): string | null {
  const d = initDb()
  const row = d
    .query<{ public_key: string }, [string]>(`SELECT public_key FROM key_cache WHERE address = ?`)
    .get(address.toLowerCase())
  return row?.public_key ?? null
}

export function getAllKeyCache(): Array<{ address: string; public_key: string }> {
  const d = initDb()
  return d
    .query<{ address: string; public_key: string }, []>(`SELECT address, public_key FROM key_cache`)
    .all()
}

// --- Groups ---

export function createGroup(id: string, name: string, members: Array<{ address: string; name?: string }>): void {
  const d = initDb()
  d.run(
    `INSERT OR IGNORE INTO groups (id, name, created_at) VALUES (?, ?, ?)`,
    [id, name, new Date().toISOString()],
  )
  for (const m of members) {
    d.run(
      `INSERT OR IGNORE INTO group_members (group_id, address, name) VALUES (?, ?, ?)`,
      [id, m.address.toLowerCase(), m.name ?? null],
    )
  }
}

export function getGroups(): Array<{ id: string; name: string; created_at: string; member_count: number }> {
  const d = initDb()
  return d
    .query<{ id: string; name: string; created_at: string; member_count: number }, []>(
      `SELECT g.id, g.name, g.created_at, COUNT(gm.address) as member_count
       FROM groups g LEFT JOIN group_members gm ON g.id = gm.group_id
       GROUP BY g.id ORDER BY g.created_at DESC`,
    )
    .all()
}

export function getGroupMembers(groupId: string): Array<{ address: string; name: string | null }> {
  const d = initDb()
  return d
    .query<{ address: string; name: string | null }, [string]>(
      `SELECT address, name FROM group_members WHERE group_id = ?`,
    )
    .all(groupId)
}

export function getGroupName(groupId: string): string | null {
  const d = initDb()
  const row = d
    .query<{ name: string }, [string]>(`SELECT name FROM groups WHERE id = ?`)
    .get(groupId)
  return row?.name ?? null
}

export function addGroupMember(groupId: string, address: string, name?: string): void {
  const d = initDb()
  d.run(
    `INSERT OR IGNORE INTO group_members (group_id, address, name) VALUES (?, ?, ?)`,
    [groupId, address.toLowerCase(), name ?? null],
  )
}

export function removeGroupMember(groupId: string, address: string): void {
  const d = initDb()
  d.run(
    `DELETE FROM group_members WHERE group_id = ? AND address = ?`,
    [groupId, address.toLowerCase()],
  )
}

export function deleteGroup(groupId: string): void {
  const d = initDb()
  d.run(`DELETE FROM group_members WHERE group_id = ?`, [groupId])
  d.run(`DELETE FROM groups WHERE id = ?`, [groupId])
}

// --- Group Invites ---

export function saveGroupInvite(invite: {
  group_id: string
  group_name: string
  from_address: string
  members: string[]
  ts: number
}): void {
  const d = initDb()
  d.run(
    `INSERT OR REPLACE INTO group_invites (group_id, group_name, from_address, members_json, ts) VALUES (?, ?, ?, ?, ?)`,
    [invite.group_id, invite.group_name, invite.from_address.toLowerCase(), JSON.stringify(invite.members), invite.ts],
  )
}

export function getGroupInvites(): Array<{
  group_id: string
  group_name: string
  from_address: string
  members: string[]
  ts: number
}> {
  const d = initDb()
  return d
    .query<{ group_id: string; group_name: string; from_address: string; members_json: string; ts: number }, []>(
      `SELECT group_id, group_name, from_address, members_json, ts FROM group_invites ORDER BY ts DESC`,
    )
    .all()
    .map(row => ({ ...row, members: JSON.parse(row.members_json) }))
}

export function deleteGroupInvite(groupId: string): void {
  const d = initDb()
  d.run(`DELETE FROM group_invites WHERE group_id = ?`, [groupId])
}

// --- Reactions ---

export function saveReaction(reaction: {
  message_id: string
  from_address: string
  emoji: string
  ts: string
}): void {
  const d = initDb()
  d.run(
    `INSERT OR REPLACE INTO reactions (message_id, from_address, emoji, ts) VALUES (?, ?, ?, ?)`,
    [reaction.message_id, reaction.from_address.toLowerCase(), reaction.emoji, reaction.ts],
  )
}

export function getReactionsForMessages(
  messageIds: string[],
): Array<{ message_id: string; from_address: string; emoji: string; ts: string }> {
  if (messageIds.length === 0) return []
  const d = initDb()
  const placeholders = messageIds.map(() => '?').join(',')
  return d
    .query<{ message_id: string; from_address: string; emoji: string; ts: string }, string[]>(
      `SELECT message_id, from_address, emoji, ts FROM reactions WHERE message_id IN (${placeholders})`,
    )
    .all(...messageIds)
}

export function getMessageById(
  id: string,
): { id: string; peer: string; direction: string; content: string; ts: string } | null {
  const d = initDb()
  return d
    .query<{ id: string; peer: string; direction: string; content: string; ts: string }, [string]>(
      `SELECT id, peer, direction, content, ts FROM messages WHERE id = ?`,
    )
    .get(id) ?? null
}

// --- Mutes ---

export type MuteKind = 'agent' | 'group' | 'all'

const ALL_MUTE_TARGET = '*'

export function addMute(target: string, kind: MuteKind, until: number | null): void {
  const d = initDb()
  d.run(
    `INSERT INTO mutes (target, kind, until, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(target, kind) DO UPDATE SET until = excluded.until, created_at = excluded.created_at`,
    [target.toLowerCase(), kind, until, Date.now()],
  )
}

export function removeMute(target: string, kind: MuteKind): boolean {
  const d = initDb()
  const result = d.run(`DELETE FROM mutes WHERE target = ? AND kind = ?`, [target.toLowerCase(), kind])
  return result.changes > 0
}

export function isMuted(target: string, kind: MuteKind): boolean {
  const d = initDb()
  const row = d
    .query<{ until: number | null }, [string, string]>(
      `SELECT until FROM mutes WHERE target = ? AND kind = ?`,
    )
    .get(target.toLowerCase(), kind)
  if (!row) return false
  if (row.until !== null && row.until <= Date.now()) {
    d.run(`DELETE FROM mutes WHERE target = ? AND kind = ?`, [target.toLowerCase(), kind])
    return false
  }
  return true
}

export function getMutes(): Array<{ target: string; kind: MuteKind; until: number | null; created_at: number }> {
  const d = initDb()
  const now = Date.now()
  d.run(`DELETE FROM mutes WHERE until IS NOT NULL AND until <= ?`, [now])
  return d
    .query<{ target: string; kind: MuteKind; until: number | null; created_at: number }, []>(
      `SELECT target, kind, until, created_at FROM mutes ORDER BY created_at DESC`,
    )
    .all()
}

export function getMuteCreatedAt(target: string, kind: MuteKind): number | null {
  const d = initDb()
  const row = d
    .query<{ created_at: number }, [string, string]>(
      `SELECT created_at FROM mutes WHERE target = ? AND kind = ?`,
    )
    .get(target.toLowerCase(), kind)
  return row?.created_at ?? null
}

export function countInboundSince(peer: string, sinceMs: number): number {
  const d = initDb()
  const sinceIso = new Date(sinceMs).toISOString()
  const row = d
    .query<{ count: number }, [string, string]>(
      `SELECT COUNT(*) as count FROM messages WHERE peer = ? AND direction = 'inbound' AND ts >= ?`,
    )
    .get(peer.toLowerCase(), sinceIso)
  return row?.count ?? 0
}

export function countAllInboundSince(sinceMs: number): number {
  const d = initDb()
  const sinceIso = new Date(sinceMs).toISOString()
  const row = d
    .query<{ count: number }, [string]>(
      `SELECT COUNT(*) as count FROM messages WHERE direction = 'inbound' AND ts >= ?`,
    )
    .get(sinceIso)
  return row?.count ?? 0
}

export function isAllMuted(): boolean {
  return isMuted(ALL_MUTE_TARGET, 'all')
}

export function addMuteAll(until: number | null): void {
  addMute(ALL_MUTE_TARGET, 'all', until)
}

export function removeMuteAll(): boolean {
  return removeMute(ALL_MUTE_TARGET, 'all')
}

export function getMuteAllCreatedAt(): number | null {
  return getMuteCreatedAt(ALL_MUTE_TARGET, 'all')
}
