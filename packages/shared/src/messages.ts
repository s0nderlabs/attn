// Server → Client
export type ServerMessage =
  | { type: 'challenge'; nonce: string }
  | { type: 'auth_ok'; address: string }
  | { type: 'auth_error'; error: string }
  | { type: 'message'; id: string; from: string; encrypted: string; signature: string; ts: number; group_id?: string; group_name?: string }
  | { type: 'key_response'; address: string; publicKey: string | null }
  | { type: 'received'; id: string }
  | { type: 'delivered'; id: string }
  | { type: 'error'; error: string }

// Client → Server
export type ClientMessage =
  | { type: 'auth'; address: string; signature: string }
  | { type: 'message'; id: string; to: string; encrypted: string; signature: string }
  | { type: 'get_key'; address: string }
  | { type: 'ack'; id: string }
