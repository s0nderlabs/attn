export { AgentMailbox } from './do.js'
export { GroupMailbox } from './group-do.js'

type Env = {
  AGENT_MAILBOX: DurableObjectNamespace
  GROUP_MAILBOX: DurableObjectNamespace
  FILE_BUCKET: R2Bucket
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-File-Key',
}

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr)
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS })
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return Response.json(
        { status: 'ok', service: 'attn-relay', version: '0.3.0' },
        { headers: CORS_HEADERS },
      )
    }

    // WebSocket upgrade
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return Response.json(
          { error: 'Expected WebSocket upgrade' },
          { status: 426, headers: CORS_HEADERS },
        )
      }

      const address = url.searchParams.get('address')
      if (!address || !isValidAddress(address)) {
        return Response.json(
          { error: 'Valid Ethereum address required as ?address= param' },
          { status: 400, headers: CORS_HEADERS },
        )
      }

      const id = env.AGENT_MAILBOX.idFromName(address.toLowerCase())
      const stub = env.AGENT_MAILBOX.get(id)
      return stub.fetch(request)
    }

    // File upload
    if (request.method === 'POST' && url.pathname === '/upload') {
      const fileKey = request.headers.get('X-File-Key')
      if (!fileKey || !/^[0-9a-f-]{36}$/.test(fileKey)) {
        return Response.json(
          { error: 'X-File-Key header required (UUID format)' },
          { status: 400, headers: CORS_HEADERS },
        )
      }
      const body = await request.arrayBuffer()
      if (!body || body.byteLength === 0) {
        return Response.json({ error: 'Empty body' }, { status: 400, headers: CORS_HEADERS })
      }
      if (body.byteLength > 10 * 1024 * 1024) {
        return Response.json({ error: 'File too large (max 10 MB)' }, { status: 413, headers: CORS_HEADERS })
      }
      await env.FILE_BUCKET.put(fileKey, body)
      return Response.json(
        { url: `https://${url.hostname}/files/${fileKey}`, key: fileKey },
        { headers: CORS_HEADERS },
      )
    }

    // File download
    if (request.method === 'GET' && url.pathname.startsWith('/files/')) {
      const fileKey = url.pathname.slice('/files/'.length)
      if (!fileKey) {
        return Response.json({ error: 'File key required' }, { status: 400, headers: CORS_HEADERS })
      }
      const object = await env.FILE_BUCKET.get(fileKey)
      if (!object) {
        return Response.json({ error: 'File not found' }, { status: 404, headers: CORS_HEADERS })
      }
      return new Response(object.body, {
        headers: { 'Content-Type': 'application/octet-stream', ...CORS_HEADERS },
      })
    }

    // Create group
    if (request.method === 'POST' && url.pathname === '/groups') {
      const body = (await request.json()) as { id: string; name: string; members: string[]; admin: string }
      if (!body.id || !body.name || !Array.isArray(body.members)) {
        return Response.json({ error: 'Invalid group payload' }, { status: 400, headers: CORS_HEADERS })
      }
      const doId = env.GROUP_MAILBOX.idFromName(body.id)
      const stub = env.GROUP_MAILBOX.get(doId)
      const resp = await stub.fetch(new Request('https://internal/init', {
        method: 'POST',
        body: JSON.stringify(body),
      }))
      return new Response(resp.body, { status: resp.status, headers: CORS_HEADERS })
    }

    // Group send
    if (request.method === 'POST' && url.pathname.match(/^\/groups\/[^/]+\/send$/)) {
      const groupId = url.pathname.split('/')[2]
      const doId = env.GROUP_MAILBOX.idFromName(groupId)
      const stub = env.GROUP_MAILBOX.get(doId)
      const resp = await stub.fetch(new Request('https://internal/deliver', {
        method: 'POST',
        body: request.body,
        headers: request.headers,
      }))
      return new Response(resp.body, { status: resp.status, headers: CORS_HEADERS })
    }

    // Group info
    if (request.method === 'GET' && url.pathname.match(/^\/groups\/[^/]+$/)) {
      const groupId = url.pathname.split('/')[2]
      const doId = env.GROUP_MAILBOX.idFromName(groupId)
      const stub = env.GROUP_MAILBOX.get(doId)
      const resp = await stub.fetch(new Request('https://internal/info'))
      return new Response(resp.body, { status: resp.status, headers: CORS_HEADERS })
    }

    // Group accept invite
    if (request.method === 'POST' && url.pathname.match(/^\/groups\/[^/]+\/accept$/)) {
      const groupId = url.pathname.split('/')[2]
      const doId = env.GROUP_MAILBOX.idFromName(groupId)
      const stub = env.GROUP_MAILBOX.get(doId)
      const resp = await stub.fetch(new Request('https://internal/accept', {
        method: 'POST',
        body: request.body,
      }))
      return new Response(resp.body, { status: resp.status, headers: CORS_HEADERS })
    }

    // Group add member
    if (request.method === 'POST' && url.pathname.match(/^\/groups\/[^/]+\/members$/)) {
      const groupId = url.pathname.split('/')[2]
      const doId = env.GROUP_MAILBOX.idFromName(groupId)
      const stub = env.GROUP_MAILBOX.get(doId)
      const resp = await stub.fetch(new Request('https://internal/members', {
        method: 'POST',
        body: request.body,
      }))
      return new Response(resp.body, { status: resp.status, headers: CORS_HEADERS })
    }

    // Group remove member
    if (request.method === 'DELETE' && url.pathname.match(/^\/groups\/[^/]+\/members\/0x[0-9a-fA-F]{40}$/)) {
      const parts = url.pathname.split('/')
      const groupId = parts[2]
      const address = parts[4]
      const doId = env.GROUP_MAILBOX.idFromName(groupId)
      const stub = env.GROUP_MAILBOX.get(doId)
      const resp = await stub.fetch(new Request(`https://internal/members/${address}`, { method: 'DELETE' }))
      return new Response(resp.body, { status: resp.status, headers: CORS_HEADERS })
    }

    return Response.json(
      { error: 'Not found' },
      { status: 404, headers: CORS_HEADERS },
    )
  },
} satisfies ExportedHandler<Env>
