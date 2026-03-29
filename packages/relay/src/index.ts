export { AgentMailbox } from './do.js'

type Env = {
  AGENT_MAILBOX: DurableObjectNamespace
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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
        { status: 'ok', service: 'attn-relay', version: '0.1.0' },
        { headers: CORS_HEADERS },
      )
    }

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

    return Response.json(
      { error: 'Not found' },
      { status: 404, headers: CORS_HEADERS },
    )
  },
} satisfies ExportedHandler<Env>
