import { DurableObject } from 'cloudflare:workers'

type Env = {
  AGENT_MAILBOX: DurableObjectNamespace
  GROUP_MAILBOX: DurableObjectNamespace
  FILE_BUCKET: R2Bucket
}

export class GroupMailbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS members (
          address TEXT PRIMARY KEY,
          role TEXT NOT NULL DEFAULT 'member',
          status TEXT NOT NULL DEFAULT 'pending',
          added_at INTEGER NOT NULL
        )
      `)
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `)
      try { this.ctx.storage.sql.exec(`ALTER TABLE members ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`) } catch {}
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // Initialize group — creator is auto-active, others get invites
    if (request.method === 'POST' && url.pathname === '/init') {
      const body = (await request.json()) as {
        id: string
        name: string
        members: string[]
        admin: string
      }

      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO meta (key, value) VALUES ('name', ?), ('admin', ?), ('id', ?)`,
        body.name,
        body.admin.toLowerCase(),
        body.id,
      )

      // Admin is active immediately, others are pending
      for (const member of body.members) {
        const isAdmin = member.toLowerCase() === body.admin.toLowerCase()
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO members (address, role, status, added_at) VALUES (?, ?, ?, ?)`,
          member.toLowerCase(),
          isAdmin ? 'admin' : 'member',
          isAdmin ? 'active' : 'pending',
          Date.now(),
        )
      }

      // Send invite to all non-admin members
      const invitePayload = JSON.stringify({
        type: 'group_invite',
        group_id: body.id,
        group_name: body.name,
        from: body.admin.toLowerCase(),
        members: body.members.map(m => m.toLowerCase()),
      })

      await Promise.allSettled(
        body.members
          .filter(m => m.toLowerCase() !== body.admin.toLowerCase())
          .map(async (member) => {
            const recipientId = this.env.AGENT_MAILBOX.idFromName(member.toLowerCase())
            const recipientStub = this.env.AGENT_MAILBOX.get(recipientId)
            await recipientStub.fetch(
              new Request('https://internal/deliver', {
                method: 'POST',
                body: JSON.stringify({
                  id: `invite-${body.id}-${member.slice(2, 8)}`,
                  from: body.admin.toLowerCase(),
                  encrypted: invitePayload,
                  signature: '',
                  ts: Date.now(),
                  group_id: body.id,
                  group_name: body.name,
                }),
              }),
            )
          }),
      )

      return Response.json({ status: 'created' })
    }

    // Accept invite — mark member as active, notify all active members
    if (request.method === 'POST' && url.pathname === '/accept') {
      const body = (await request.json()) as { address: string }
      this.ctx.storage.sql.exec(
        `UPDATE members SET status = 'active' WHERE address = ?`,
        body.address.toLowerCase(),
      )

      // Notify all other active members that someone joined
      const groupId = [...this.ctx.storage.sql.exec<{ value: string }>(
        `SELECT value FROM meta WHERE key = 'id'`,
      )][0]?.value
      const groupName = [...this.ctx.storage.sql.exec<{ value: string }>(
        `SELECT value FROM meta WHERE key = 'name'`,
      )][0]?.value
      const allMembers = [...this.ctx.storage.sql.exec<{ address: string }>(
        `SELECT address FROM members`,
      )]
      const activeMembers = [...this.ctx.storage.sql.exec<{ address: string }>(
        `SELECT address FROM members WHERE status = 'active' AND address != ?`,
        body.address.toLowerCase(),
      )]

      if (groupId && groupName) {
        const updatePayload = JSON.stringify({
          type: 'group_member_update',
          group_id: groupId,
          group_name: groupName,
          action: 'joined',
          address: body.address.toLowerCase(),
          members: allMembers.map(m => m.address),
        })

        await Promise.allSettled(
          activeMembers.map(async (member) => {
            const recipientId = this.env.AGENT_MAILBOX.idFromName(member.address)
            const recipientStub = this.env.AGENT_MAILBOX.get(recipientId)
            await recipientStub.fetch(
              new Request('https://internal/deliver', {
                method: 'POST',
                body: JSON.stringify({
                  id: `update-${groupId}-${Date.now()}`,
                  from: body.address.toLowerCase(),
                  encrypted: updatePayload,
                  signature: '',
                  ts: Date.now(),
                  group_id: groupId,
                  group_name: groupName,
                }),
              }),
            )
          }),
        )
      }

      return Response.json({ status: 'accepted' })
    }

    // Get group info
    if (request.method === 'GET' && url.pathname === '/info') {
      const name = [...this.ctx.storage.sql.exec<{ value: string }>(
        `SELECT value FROM meta WHERE key = 'name'`,
      )][0]?.value ?? 'unknown'

      const members = [...this.ctx.storage.sql.exec<{ address: string; role: string; status: string }>(
        `SELECT address, role, status FROM members ORDER BY added_at ASC`,
      )]

      return Response.json({ name, members })
    }

    // Add member (sends invite)
    if (request.method === 'POST' && url.pathname === '/members') {
      const body = (await request.json()) as { address: string; from?: string }
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO members (address, role, status, added_at) VALUES (?, 'member', 'pending', ?)`,
        body.address.toLowerCase(),
        Date.now(),
      )

      // Send invite
      const groupId = [...this.ctx.storage.sql.exec<{ value: string }>(
        `SELECT value FROM meta WHERE key = 'id'`,
      )][0]?.value
      const groupName = [...this.ctx.storage.sql.exec<{ value: string }>(
        `SELECT value FROM meta WHERE key = 'name'`,
      )][0]?.value
      const allMembers = [...this.ctx.storage.sql.exec<{ address: string }>(
        `SELECT address FROM members`,
      )]

      if (groupId && groupName) {
        const recipientId = this.env.AGENT_MAILBOX.idFromName(body.address.toLowerCase())
        const recipientStub = this.env.AGENT_MAILBOX.get(recipientId)
        await recipientStub.fetch(
          new Request('https://internal/deliver', {
            method: 'POST',
            body: JSON.stringify({
              id: `invite-${groupId}-${body.address.slice(2, 8)}`,
              from: body.from ?? 'unknown',
              encrypted: JSON.stringify({
                type: 'group_invite',
                group_id: groupId,
                group_name: groupName,
                from: body.from ?? 'unknown',
                members: allMembers.map(m => m.address),
              }),
              signature: '',
              ts: Date.now(),
              group_id: groupId,
              group_name: groupName,
            }),
          }),
        ).catch(() => {})
      }

      return Response.json({ status: 'invited' })
    }

    // Transfer admin
    if (request.method === 'POST' && url.pathname === '/transfer') {
      const body = (await request.json()) as { from: string; to: string }
      const currentAdmin = [...this.ctx.storage.sql.exec<{ value: string }>(
        `SELECT value FROM meta WHERE key = 'admin'`,
      )][0]?.value

      if (!currentAdmin || currentAdmin !== body.from.toLowerCase()) {
        return Response.json({ error: 'Only the current admin can transfer' }, { status: 403 })
      }

      this.ctx.storage.sql.exec(`UPDATE members SET role = 'member' WHERE address = ?`, body.from.toLowerCase())
      this.ctx.storage.sql.exec(`UPDATE members SET role = 'admin' WHERE address = ?`, body.to.toLowerCase())
      this.ctx.storage.sql.exec(`UPDATE meta SET value = ? WHERE key = 'admin'`, body.to.toLowerCase())

      const groupId = [...this.ctx.storage.sql.exec<{ value: string }>(
        `SELECT value FROM meta WHERE key = 'id'`,
      )][0]?.value
      const groupName = [...this.ctx.storage.sql.exec<{ value: string }>(
        `SELECT value FROM meta WHERE key = 'name'`,
      )][0]?.value
      const activeMembers = [...this.ctx.storage.sql.exec<{ address: string }>(
        `SELECT address FROM members WHERE status = 'active'`,
      )]

      if (groupId && groupName) {
        const updatePayload = JSON.stringify({
          type: 'group_member_update',
          group_id: groupId,
          group_name: groupName,
          action: 'admin_transferred',
          address: body.to.toLowerCase(),
          members: activeMembers.map(m => m.address),
        })

        await Promise.allSettled(
          activeMembers.map(async (member) => {
            const recipientId = this.env.AGENT_MAILBOX.idFromName(member.address)
            const recipientStub = this.env.AGENT_MAILBOX.get(recipientId)
            await recipientStub.fetch(
              new Request('https://internal/deliver', {
                method: 'POST',
                body: JSON.stringify({
                  id: `update-${groupId}-${Date.now()}`,
                  from: body.to.toLowerCase(),
                  encrypted: updatePayload,
                  signature: '',
                  ts: Date.now(),
                  group_id: groupId,
                  group_name: groupName,
                }),
              }),
            )
          }),
        )
      }

      return Response.json({ status: 'transferred' })
    }

    // Remove member — notify remaining active members
    if (request.method === 'DELETE' && url.pathname.startsWith('/members/')) {
      const address = url.pathname.slice('/members/'.length).toLowerCase()
      this.ctx.storage.sql.exec(`DELETE FROM members WHERE address = ?`, address)

      const groupId = [...this.ctx.storage.sql.exec<{ value: string }>(
        `SELECT value FROM meta WHERE key = 'id'`,
      )][0]?.value
      const groupName = [...this.ctx.storage.sql.exec<{ value: string }>(
        `SELECT value FROM meta WHERE key = 'name'`,
      )][0]?.value
      const remaining = [...this.ctx.storage.sql.exec<{ address: string }>(
        `SELECT address FROM members WHERE status = 'active'`,
      )]

      if (groupId && groupName) {
        const updatePayload = JSON.stringify({
          type: 'group_member_update',
          group_id: groupId,
          group_name: groupName,
          action: 'left',
          address,
          members: remaining.map(m => m.address),
        })

        await Promise.allSettled(
          remaining.map(async (member) => {
            const recipientId = this.env.AGENT_MAILBOX.idFromName(member.address)
            const recipientStub = this.env.AGENT_MAILBOX.get(recipientId)
            await recipientStub.fetch(
              new Request('https://internal/deliver', {
                method: 'POST',
                body: JSON.stringify({
                  id: `update-${groupId}-${Date.now()}`,
                  from: address,
                  encrypted: updatePayload,
                  signature: '',
                  ts: Date.now(),
                  group_id: groupId,
                  group_name: groupName,
                }),
              }),
            )
          }),
        )
      }

      return Response.json({ status: 'removed' })
    }

    // Deliver — fan out to ACTIVE members only
    if (request.method === 'POST' && url.pathname === '/deliver') {
      const body = (await request.json()) as {
        id: string
        from: string
        group_id: string
        group_name: string
        blobs: Record<string, string>
      }

      const members = [...this.ctx.storage.sql.exec<{ address: string }>(
        `SELECT address FROM members WHERE status = 'active'`,
      )]

      const results = await Promise.allSettled(
        members
          .filter(m => body.blobs[m.address])
          .map(async (member) => {
            const recipientId = this.env.AGENT_MAILBOX.idFromName(member.address)
            const recipientStub = this.env.AGENT_MAILBOX.get(recipientId)
            await recipientStub.fetch(
              new Request('https://internal/deliver', {
                method: 'POST',
                body: JSON.stringify({
                  id: `${body.id}-${member.address.slice(2, 8)}`,
                  from: body.from,
                  encrypted: body.blobs[member.address],
                  signature: '',
                  ts: Date.now(),
                  group_id: body.group_id,
                  group_name: body.group_name,
                }),
              }),
            )
          }),
      )
      const delivered = results.filter(r => r.status === 'fulfilled').length

      return Response.json({ status: 'delivered', count: delivered })
    }

    return Response.json({ error: 'Not found' }, { status: 404 })
  }
}
