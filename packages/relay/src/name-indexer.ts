import { DurableObject } from 'cloudflare:workers'
import { decodeAbiParameters, encodeFunctionData, decodeFunctionResult, keccak256, toHex } from 'viem'

// Minimal ABI for on-chain fallback calls (resolve + namehash only)
const resolveAbi = [
  { type: 'function', name: 'resolve', inputs: [{ name: 'label', type: 'string' }], outputs: [{ name: 'owner_', type: 'address' }, { name: 'node', type: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'namehash', inputs: [{ name: 'label', type: 'string' }], outputs: [{ name: '', type: 'bytes32' }], stateMutability: 'pure' },
  { type: 'function', name: 'primaryNameOf', inputs: [{ name: 'addr', type: 'address' }], outputs: [{ name: '', type: 'string' }], stateMutability: 'view' },
] as const

type Env = {
  AGENT_MAILBOX: DurableObjectNamespace
  NAME_INDEXER: DurableObjectNamespace
  BASE_HTTP_RPC: string
  BASE_HYPERSYNC_URL: string
  ENVIO_TOKEN_API: string
}

// HyperSync log shape — separate topic fields, block_number as integer
interface HyperSyncLog {
  block_number?: number
  transaction_hash?: string
  log_index?: number
  address?: string
  topic0?: string
  topic1?: string
  topic2?: string
  topic3?: string
  data?: string
}

const CONTRACT_ADDRESS = '0x5caDD2F7d8fC6B35bb220cC3DB8DBc187E02dC7A'
const ALARM_INTERVAL_MS = 30_000
const PRIMARY_CACHE_TTL_MS = 5 * 60 * 1000 // 5 min — cosmetic display, safe to cache
const DEPLOY_BLOCK = 44327000

// Event topics
const NAME_REGISTERED_TOPIC = keccak256(toHex('NameRegistered(bytes32,string,address,uint256)'))
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

export class NameIndexer extends DurableObject<Env> {
  private primaryCache = new Map<string, { name: string | null; ts: number }>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS names (
          label TEXT PRIMARY KEY,
          address TEXT NOT NULL,
          token_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS sync_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `)
      try {
        this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_names_address ON names(address)`)
      } catch {}

      // Schedule alarm if none exists
      const alarm = await this.ctx.storage.getAlarm()
      if (!alarm) {
        await this.ctx.storage.setAlarm(Date.now() + 1000)
      }
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/resolve') {
      const name = url.searchParams.get('name')?.toLowerCase()
      if (!name) return Response.json({ address: null })

      // Always resolve on-chain — names can transfer at any time, stale cache = wrong recipient
      const address = await this.resolveOnChain(name)
      if (address) {
        const tokenId = await this.getTokenId(name)
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO names (label, address, token_id, updated_at) VALUES (?, ?, ?, ?)`,
          name, address, tokenId ?? '', Date.now()
        )
      }
      return Response.json({ address })
    }

    if (url.pathname === '/names') {
      const address = url.searchParams.get('address')?.toLowerCase()
      if (!address) return Response.json({ names: [] })

      const rows = [...this.ctx.storage.sql.exec<{ label: string }>(
        `SELECT label FROM names WHERE lower(address) = ? ORDER BY label`, address
      )]
      return Response.json({ names: rows.map(r => r.label) })
    }

    if (url.pathname === '/primary') {
      const address = url.searchParams.get('address')?.toLowerCase()
      if (!address) return Response.json({ name: null })

      // Check in-memory cache (5 min TTL — cosmetic, safe to cache)
      const cached = this.primaryCache.get(address)
      if (cached && Date.now() - cached.ts < PRIMARY_CACHE_TTL_MS) {
        return Response.json({ name: cached.name })
      }

      // 1. Check on-chain primary name
      let result: string | null = null
      const primary = await this.primaryNameOnChain(address)
      if (primary) {
        result = primary + '.attn'
      } else {
        // 2. Fallback: pick any name they own from SQLite cache
        const owned = [...this.ctx.storage.sql.exec<{ label: string }>(
          `SELECT label FROM names WHERE lower(address) = ? LIMIT 1`, address
        )]
        if (owned.length > 0) result = owned[0].label + '.attn'
      }

      this.primaryCache.set(address, { name: result, ts: Date.now() })
      return Response.json({ name: result })
    }

    if (url.pathname === '/sync' && request.method === 'POST') {
      try {
        const result = await this.syncFromHyperSync()
        return Response.json({ synced: true, ...result })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return Response.json({ synced: false, error: msg }, { status: 500 })
      }
    }

    if (url.pathname === '/debug') {
      const lastBlockRows = [...this.ctx.storage.sql.exec<{ value: string }>(
        `SELECT value FROM sync_state WHERE key = 'last_block'`
      )]
      const namesCount = [...this.ctx.storage.sql.exec<{ c: number }>(
        `SELECT COUNT(*) as c FROM names`
      )][0]?.c ?? 0
      return Response.json({
        last_block: lastBlockRows.length > 0 ? parseInt(lastBlockRows[0].value) : null,
        names_count: namesCount,
        primary_cache_size: this.primaryCache.size,
      })
    }

    return new Response('Not found', { status: 404 })
  }

  async alarm(): Promise<void> {
    try {
      await this.syncFromHyperSync()
    } catch (err) {
      console.error('NameIndexer sync failed:', err instanceof Error ? err.message : String(err))
    }
    // Always reschedule, even on error
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS)
  }

  private handleLog(log: HyperSyncLog): void {
    const topic0 = log.topic0

    if (topic0 === NAME_REGISTERED_TOPIC) {
      // NameRegistered(bytes32 indexed node, string label, address indexed owner, uint256 tokenId)
      // topic1 = node, topic2 = owner (padded)
      if (!log.topic2 || !log.data) return
      const owner = ('0x' + log.topic2.slice(26)).toLowerCase()
      const decoded = decodeAbiParameters(
        [{ name: 'label', type: 'string' }, { name: 'tokenId', type: 'uint256' }],
        log.data as `0x${string}`
      )
      const label = (decoded[0] as string).toLowerCase()
      const tokenId = (decoded[1] as bigint).toString()

      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO names (label, address, token_id, updated_at) VALUES (?, ?, ?, ?)`,
        label, owner, tokenId, Date.now()
      )
      this.primaryCache.delete(owner)
    } else if (topic0 === TRANSFER_TOPIC) {
      // Transfer(address indexed from, address indexed to, uint256 indexed tokenId)
      if (!log.topic1 || !log.topic2 || !log.topic3) return
      const from = ('0x' + log.topic1.slice(26)).toLowerCase()
      const to = ('0x' + log.topic2.slice(26)).toLowerCase()
      const tokenId = BigInt(log.topic3).toString()

      if (to === '0x0000000000000000000000000000000000000000') {
        // Burn — delete name
        this.ctx.storage.sql.exec(`DELETE FROM names WHERE token_id = ?`, tokenId)
      } else {
        // Transfer — update owner
        this.ctx.storage.sql.exec(
          `UPDATE names SET address = ?, updated_at = ? WHERE token_id = ?`,
          to, Date.now(), tokenId
        )
      }
      this.primaryCache.delete(from)
      this.primaryCache.delete(to)
    }
  }

  private async syncFromHyperSync(): Promise<{ events: number; from_block: number; to_block: number; pages: number }> {
    const rows = [...this.ctx.storage.sql.exec<{ value: string }>(
      `SELECT value FROM sync_state WHERE key = 'last_block'`
    )]
    const startFromBlock = rows.length > 0 ? parseInt(rows[0].value) + 1 : DEPLOY_BLOCK

    let currentFromBlock = startFromBlock
    let totalEvents = 0
    let archiveHeight = 0
    let pages = 0
    const MAX_PAGES = 50 // safety: HyperSync responses are large; never need more than this in one alarm

    while (pages < MAX_PAGES) {
      pages++

      const body = JSON.stringify({
        from_block: currentFromBlock,
        // omit to_block to query up to archive head
        logs: [{
          address: [CONTRACT_ADDRESS.toLowerCase()],
          topics: [[NAME_REGISTERED_TOPIC, TRANSFER_TOPIC]],
        }],
        field_selection: {
          log: ['block_number', 'transaction_hash', 'log_index', 'address', 'topic0', 'topic1', 'topic2', 'topic3', 'data'],
        },
      })

      const resp = await fetch(this.env.BASE_HYPERSYNC_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.env.ENVIO_TOKEN_API}`,
        },
        body,
      })

      if (!resp.ok) {
        const text = await resp.text()
        throw new Error(`HyperSync HTTP ${resp.status}: ${text.slice(0, 200)}`)
      }

      const result = await resp.json() as {
        data?: Array<{ logs?: HyperSyncLog[] }>
        archive_height?: number
        next_block?: number
        error?: string
      }

      if (result.error) {
        throw new Error(`HyperSync error: ${result.error}`)
      }

      archiveHeight = result.archive_height ?? archiveHeight

      let pageEvents = 0
      for (const batch of result.data ?? []) {
        for (const log of batch.logs ?? []) {
          this.handleLog(log)
          pageEvents++
        }
      }
      totalEvents += pageEvents

      // Advance last_block to next_block - 1 (HyperSync's next_block is the start of the next page)
      const nextBlock = result.next_block
      if (nextBlock === undefined || nextBlock <= currentFromBlock) {
        // No progress (shouldn't happen) — bail to avoid infinite loop
        break
      }

      const newLastBlock = nextBlock - 1
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO sync_state (key, value) VALUES ('last_block', ?)`,
        newLastBlock.toString()
      )
      currentFromBlock = nextBlock

      // Stop if we've caught up to the archive head
      if (nextBlock > archiveHeight) break
    }

    return { events: totalEvents, from_block: startFromBlock, to_block: archiveHeight, pages }
  }

  private async resolveOnChain(label: string): Promise<string | null> {
    const calldata = encodeFunctionData({
      abi: resolveAbi,
      functionName: 'resolve',
      args: [label],
    })

    const resp = await fetch(this.env.BASE_HTTP_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: CONTRACT_ADDRESS, data: calldata }, 'latest'],
      }),
    })
    const result = (await resp.json()) as { result?: string }
    if (!result.result || result.result === '0x') return null

    const decoded = decodeFunctionResult({
      abi: resolveAbi,
      functionName: 'resolve',
      data: result.result as `0x${string}`,
    })
    const address = (decoded as [string, string])[0]
    if (address === '0x0000000000000000000000000000000000000000') return null
    return address.toLowerCase()
  }

  private async getTokenId(label: string): Promise<string | null> {
    const calldata = encodeFunctionData({
      abi: resolveAbi,
      functionName: 'namehash',
      args: [label],
    })

    const resp = await fetch(this.env.BASE_HTTP_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: CONTRACT_ADDRESS, data: calldata }, 'latest'],
      }),
    })
    const result = (await resp.json()) as { result?: string }
    if (!result.result) return null
    return BigInt(result.result).toString()
  }

  private async primaryNameOnChain(address: string): Promise<string | null> {
    const calldata = encodeFunctionData({
      abi: resolveAbi,
      functionName: 'primaryNameOf',
      args: [address as `0x${string}`],
    })

    const resp = await fetch(this.env.BASE_HTTP_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_call',
        params: [{ to: CONTRACT_ADDRESS, data: calldata }, 'latest'],
      }),
    })
    const result = (await resp.json()) as { result?: string }
    if (!result.result || result.result === '0x' || result.result.length <= 66) return null

    const decoded = decodeFunctionResult({
      abi: resolveAbi,
      functionName: 'primaryNameOf',
      data: result.result as `0x${string}`,
    })
    const name = decoded as string
    return name || null
  }
}
