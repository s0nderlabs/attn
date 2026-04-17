import type { privateKeyToAccount } from 'viem/accounts'

export type PresenceState = 'online' | 'away'

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
  pendingPresenceRequests: new Map<string, Array<(result: { state: PresenceState; message: string | null } | null) => void>>(),
  presence: 'online' as PresenceState,
  presenceMessage: null as string | null,
  returningFromAwayAt: null as number | null,
  awaySummaryBuffer: 0,
  awaySummaryTimer: null as ReturnType<typeof setTimeout> | null,
  awayNoticesLastAt: new Map<string, number>(),
}
