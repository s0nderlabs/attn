import type { privateKeyToAccount } from 'viem/accounts'

export const state = {
  lastInboundFrom: null as string | null,
  lastInboundGroup: null as string | null,
  lastInboundMessageId: null as string | null,
  keyCache: new Map<string, string>(),
  ws: null as WebSocket | null,
  authenticated: false,
  lastPongAt: 0,
  address: '',
  account: null as ReturnType<typeof privateKeyToAccount> | null,
  privateKey: '' as `0x${string}`,
  sessionName: null as string | null,
  localServer: null as import('node:net').Server | null,
  pendingKeyRequests: new Map<string, Array<(key: string | null) => void>>(),
  pendingResolveRequests: new Map<string, Array<(result: { address: string; publicKey: string | null } | null) => void>>(),
}
