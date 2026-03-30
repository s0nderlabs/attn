export { AgentMailbox } from './do.js'
export { GroupMailbox } from './group-do.js'
import { recoverMessageAddress } from 'viem'

type Env = {
  AGENT_MAILBOX: DurableObjectNamespace
  GROUP_MAILBOX: DurableObjectNamespace
  FILE_BUCKET: R2Bucket
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-File-Key, X-Attn-Address, X-Attn-Timestamp, X-Attn-Signature',
}

function isValidAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr)
}

async function requireAuth(request: Request): Promise<string> {
  const address = request.headers.get('X-Attn-Address')
  const timestamp = request.headers.get('X-Attn-Timestamp')
  const signature = request.headers.get('X-Attn-Signature')

  if (!address || !timestamp || !signature) {
    throw new Error('Missing auth headers')
  }

  const ts = parseInt(timestamp, 10)
  if (isNaN(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
    throw new Error('Timestamp expired')
  }

  const url = new URL(request.url)
  const nonce = `${request.method}:${url.pathname}:${timestamp}`

  const recovered = await recoverMessageAddress({
    message: nonce,
    signature: signature as `0x${string}`,
  })

  if (recovered.toLowerCase() !== address.toLowerCase()) {
    throw new Error('Signature mismatch')
  }

  return address.toLowerCase()
}

function authError(msg: string): Response {
  return Response.json({ error: msg }, { status: 401, headers: CORS_HEADERS })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS })
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return Response.json(
        { status: 'ok', service: 'attn-relay', version: '0.4.0' },
        { headers: CORS_HEADERS },
      )
    }

    // WebSocket upgrade (has own auth via challenge-response)
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return Response.json({ error: 'Expected WebSocket upgrade' }, { status: 426, headers: CORS_HEADERS })
      }
      const address = url.searchParams.get('address')
      if (!address || !isValidAddress(address)) {
        return Response.json({ error: 'Valid address required' }, { status: 400, headers: CORS_HEADERS })
      }
      const id = env.AGENT_MAILBOX.idFromName(address.toLowerCase())
      return env.AGENT_MAILBOX.get(id).fetch(request)
    }

    // File upload (auth required)
    if (request.method === 'POST' && url.pathname === '/upload') {
      try { await requireAuth(request) } catch (e) { return authError((e as Error).message) }

      const fileKey = request.headers.get('X-File-Key')
      if (!fileKey || !/^[0-9a-f-]{36}$/.test(fileKey)) {
        return Response.json({ error: 'X-File-Key required (UUID)' }, { status: 400, headers: CORS_HEADERS })
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

    // File download (no auth — encrypted content-addressed)
    if (request.method === 'GET' && url.pathname.startsWith('/files/')) {
      const fileKey = url.pathname.slice('/files/'.length)
      if (!fileKey) return Response.json({ error: 'File key required' }, { status: 400, headers: CORS_HEADERS })
      const object = await env.FILE_BUCKET.get(fileKey)
      if (!object) return Response.json({ error: 'File not found' }, { status: 404, headers: CORS_HEADERS })
      return new Response(object.body, {
        headers: { 'Content-Type': 'application/octet-stream', ...CORS_HEADERS },
      })
    }

    // Batch online/offline status
    if (request.method === 'POST' && url.pathname === '/status') {
      const body = (await request.json()) as { addresses: string[] }
      if (!Array.isArray(body.addresses)) {
        return Response.json({ error: 'addresses array required' }, { status: 400, headers: CORS_HEADERS })
      }
      const results: Record<string, { online: boolean }> = {}
      await Promise.allSettled(
        body.addresses.map(async (addr) => {
          const id = env.AGENT_MAILBOX.idFromName(addr.toLowerCase())
          const stub = env.AGENT_MAILBOX.get(id)
          const resp = await stub.fetch(new Request('https://internal/status'))
          results[addr.toLowerCase()] = (await resp.json()) as { online: boolean }
        }),
      )
      return Response.json(results, { headers: CORS_HEADERS })
    }

    // Create group (auth required)
    if (request.method === 'POST' && url.pathname === '/groups') {
      try { await requireAuth(request) } catch (e) { return authError((e as Error).message) }

      const body = (await request.json()) as { id: string; name: string; members: string[]; admin: string }
      if (!body.id || !body.name || !Array.isArray(body.members)) {
        return Response.json({ error: 'Invalid group payload' }, { status: 400, headers: CORS_HEADERS })
      }
      const doId = env.GROUP_MAILBOX.idFromName(body.id)
      const stub = env.GROUP_MAILBOX.get(doId)
      const resp = await stub.fetch(new Request('https://internal/init', {
        method: 'POST', body: JSON.stringify(body),
      }))
      return new Response(resp.body, { status: resp.status, headers: CORS_HEADERS })
    }

    // Group send (auth required)
    if (request.method === 'POST' && url.pathname.match(/^\/groups\/[^/]+\/send$/)) {
      try { await requireAuth(request) } catch (e) { return authError((e as Error).message) }

      const groupId = url.pathname.split('/')[2]
      const doId = env.GROUP_MAILBOX.idFromName(groupId)
      const stub = env.GROUP_MAILBOX.get(doId)
      const resp = await stub.fetch(new Request('https://internal/deliver', {
        method: 'POST', body: request.body, headers: request.headers,
      }))
      return new Response(resp.body, { status: resp.status, headers: CORS_HEADERS })
    }

    // Group info (no auth — non-sensitive)
    if (request.method === 'GET' && url.pathname.match(/^\/groups\/[^/]+$/)) {
      const groupId = url.pathname.split('/')[2]
      const doId = env.GROUP_MAILBOX.idFromName(groupId)
      const stub = env.GROUP_MAILBOX.get(doId)
      const resp = await stub.fetch(new Request('https://internal/info'))
      return new Response(resp.body, { status: resp.status, headers: CORS_HEADERS })
    }

    // Group accept (auth required)
    if (request.method === 'POST' && url.pathname.match(/^\/groups\/[^/]+\/accept$/)) {
      try { await requireAuth(request) } catch (e) { return authError((e as Error).message) }

      const groupId = url.pathname.split('/')[2]
      const doId = env.GROUP_MAILBOX.idFromName(groupId)
      const stub = env.GROUP_MAILBOX.get(doId)
      const resp = await stub.fetch(new Request('https://internal/accept', {
        method: 'POST', body: request.body,
      }))
      return new Response(resp.body, { status: resp.status, headers: CORS_HEADERS })
    }

    // Group add member (auth required)
    if (request.method === 'POST' && url.pathname.match(/^\/groups\/[^/]+\/members$/)) {
      try { await requireAuth(request) } catch (e) { return authError((e as Error).message) }

      const groupId = url.pathname.split('/')[2]
      const doId = env.GROUP_MAILBOX.idFromName(groupId)
      const stub = env.GROUP_MAILBOX.get(doId)
      const resp = await stub.fetch(new Request('https://internal/members', {
        method: 'POST', body: request.body,
      }))
      return new Response(resp.body, { status: resp.status, headers: CORS_HEADERS })
    }

    // Group transfer admin (auth required)
    if (request.method === 'POST' && url.pathname.match(/^\/groups\/[^/]+\/transfer$/)) {
      try { await requireAuth(request) } catch (e) { return authError((e as Error).message) }

      const groupId = url.pathname.split('/')[2]
      const doId = env.GROUP_MAILBOX.idFromName(groupId)
      const stub = env.GROUP_MAILBOX.get(doId)
      const resp = await stub.fetch(new Request('https://internal/transfer', {
        method: 'POST', body: request.body,
      }))
      return new Response(resp.body, { status: resp.status, headers: CORS_HEADERS })
    }

    // Group remove/kick member (auth required)
    if (request.method === 'DELETE' && url.pathname.match(/^\/groups\/[^/]+\/members\/0x[0-9a-fA-F]{40}$/)) {
      try { await requireAuth(request) } catch (e) { return authError((e as Error).message) }

      const parts = url.pathname.split('/')
      const groupId = parts[2]
      const address = parts[4]
      const doId = env.GROUP_MAILBOX.idFromName(groupId)
      const stub = env.GROUP_MAILBOX.get(doId)
      const resp = await stub.fetch(new Request(`https://internal/members/${address}`, { method: 'DELETE' }))
      return new Response(resp.body, { status: resp.status, headers: CORS_HEADERS })
    }

    return Response.json({ error: 'Not found' }, { status: 404, headers: CORS_HEADERS })
  },
} satisfies ExportedHandler<Env>
