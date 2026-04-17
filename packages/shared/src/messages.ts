// Server → Client
export type ServerMessage =
  | { type: 'challenge'; nonce: string }
  | { type: 'auth_ok'; address: string }
  | { type: 'auth_error'; error: string }
  | { type: 'message'; id: string; from: string; from_name?: string; encrypted: string; signature: string; ts: number; group_id?: string; group_name?: string }
  | { type: 'reaction'; id: string; from: string; from_name?: string; message_id: string; encrypted: string; signature: string; ts: number; group_id?: string; group_name?: string }
  | { type: 'key_response'; address: string; publicKey: string | null }
  | { type: 'resolve_response'; name: string; address: string | null; publicKey?: string | null }
  | { type: 'presence_response'; address: string; state: 'online' | 'away'; message: string | null }
  | { type: 'delivery_status'; id: string; to: string; status: 'delivered' | 'queued'; recipient_state?: 'online' | 'away'; recipient_message?: string | null }
  | { type: 'received'; id: string }
  | { type: 'delivered'; id: string }
  | { type: 'error'; error: string }

// Client → Server
export type ClientMessage =
  | { type: 'auth'; address: string; signature: string }
  | { type: 'message'; id: string; to: string; encrypted: string; signature: string }
  | { type: 'reaction'; id: string; to: string; message_id: string; encrypted: string; signature: string }
  | { type: 'get_key'; address: string }
  | { type: 'resolve'; name: string }
  | { type: 'presence_set'; state: 'online' | 'away'; message?: string | null }
  | { type: 'presence_query'; address: string }
  | { type: 'ack'; id: string }
