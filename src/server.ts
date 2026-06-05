import http from 'node:http';
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws';
import { state, isRelayReady } from './state.js';
import {
  encryptMessage,
  signEnvelope,
  decryptMessage,
} from './crypto.js';
import {
  saveMessage,
  getHistory,
  addContact,
  getContacts,
  getContactName,
  removeContact,
  getKeyCache,
  saveOutbox,
} from './db.js';
import { requestKey } from './relay.js';
import { DAEMON_PORT } from './constants.js';

// --- Connected pi clients ---

const sessions = new Map<string, WsWebSocket>();
const unnamedClients = new Set<WsWebSocket>();

// --- Broadcast to all pi clients ---

export function broadcastInbound(event: object): void {
  const data = JSON.stringify(event);
  for (const client of sessions.values()) {
    try {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    } catch {
      // ignore
    }
  }
  for (const client of unnamedClients) {
    try {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    } catch {
      // ignore
    }
  }
}

// --- HTTP handler ---

function parseBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
  });
}

function sendJson(
  res: http.ServerResponse,
  data: unknown,
  status = 200,
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function sendError(
  res: http.ServerResponse,
  message: string,
  status = 400,
): void {
  sendJson(res, { error: message }, status);
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${DAEMON_PORT}`);
  const path = url.pathname;

  try {
    // POST /send — { to, message }
    if (req.method === 'POST' && path === '/send') {
      const body = await parseBody(req);
      const { to, message } = JSON.parse(body) as {
        to: string;
        message: string;
      };

      if (!to || !message) {
        return sendError(res, 'to and message are required');
      }

      if (!isRelayReady()) {
        return sendError(res, 'Not connected to relay', 503);
      }

      const publicKey = await requestKey(to);
      if (!publicKey) {
        return sendError(
          res,
          `Could not find public key for ${to}`,
          404,
        );
      }

      const encrypted = encryptMessage(publicKey, message);
      const id = crypto.randomUUID();
      const envelope = {
        id,
        to: to.toLowerCase(),
        encrypted,
      };
      const signature = await signEnvelope(state.account!, envelope);

      try {
        state.relayWs!.send(
          JSON.stringify({
            type: 'message',
            id,
            to: to.toLowerCase(),
            encrypted,
            signature,
          }),
        );
      } catch {
        saveOutbox({
          id,
          to_address: to.toLowerCase(),
          encrypted,
          signature,
          ts: Date.now(),
        });
      }

      saveMessage({
        id,
        peer: to,
        direction: 'outbound',
        content: message,
        ts: new Date().toISOString(),
      });

      return sendJson(res, { id, status: 'sent' });
    }

    // GET /peers
    if (req.method === 'GET' && path === '/peers') {
      const peers = getContacts();
      return sendJson(res, { peers });
    }

    // GET /local-peers
    if (req.method === 'GET' && path === '/local-peers') {
      const sessionList = Array.from(sessions.keys());
      return sendJson(res, { sessions: sessionList, count: sessionList.length });
    }

    // GET /history?with=ADDR&limit=N
    if (req.method === 'GET' && path === '/history') {
      const peer = url.searchParams.get('with');
      const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);

      if (!peer) {
        return sendError(res, 'with parameter is required');
      }

      const messages = getHistory(peer, limit);
      return sendJson(res, { messages });
    }

    // POST /contacts — { address, name? }
    if (req.method === 'POST' && path === '/contacts') {
      const body = await parseBody(req);
      const { address, name } = JSON.parse(body) as {
        address: string;
        name?: string;
      };

      if (!address) {
        return sendError(res, 'address is required');
      }

      addContact(address, name);
      return sendJson(res, { status: 'added', address });
    }

    // DELETE /contacts/:address
    if (req.method === 'DELETE' && path.startsWith('/contacts/')) {
      const address = path.slice('/contacts/'.length);
      removeContact(address);
      return sendJson(res, { status: 'removed', address });
    }

    // GET /status
    if (req.method === 'GET' && path === '/status') {
      return sendJson(res, {
        address: state.address,
        relayConnected: isRelayReady(),
        peers: getContacts().length,
      });
    }

    // 404
    return sendError(res, 'Not found', 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return sendError(res, message, 500);
  }
}

// --- Start server ---

export function startServer(): http.Server {
  const server = http.createServer(handleRequest);

  // WebSocket server on same port
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws: WsWebSocket, req) => {
    // Parse session name from query param
    let sessionName: string | null = null;
    try {
      const url = new URL(req.url || '/', `http://localhost:${DAEMON_PORT}`);
      sessionName = url.searchParams.get('session');
    } catch {
      // ignore
    }

    if (sessionName) {
      sessions.set(sessionName, ws);
    } else {
      unnamedClients.add(ws);
    }

    // Send current status on connect
    try {
      ws.send(
        JSON.stringify({
          type: 'status',
          address: state.address,
          relayConnected: isRelayReady(),
          session: sessionName,
        }),
      );
    } catch {
      // ignore
    }

    // Handle incoming messages from pi extensions
    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          type: string;
          to?: string;
          message?: string;
          [key: string]: unknown;
        };

        // Local message routing
        if (msg.type === 'local' && msg.to && msg.message) {
          const target = sessions.get(msg.to);
          if (target && target.readyState === WebSocket.OPEN) {
            const fromSession = sessionName || 'unknown';
            target.send(
              JSON.stringify({
                type: 'message',
                from: fromSession,
                message: msg.message,
                id: crypto.randomUUID(),
                ts: Date.now(),
                local: true,
              }),
            );
            // Acknowledge to sender
            ws.send(
              JSON.stringify({
                type: 'local-ack',
                to: msg.to,
                status: 'delivered',
              }),
            );
          } else {
            ws.send(
              JSON.stringify({
                type: 'local-ack',
                to: msg.to,
                status: 'offline',
              }),
            );
          }
        }
      } catch {
        // ignore
      }
    });

    ws.on('close', () => {
      if (sessionName) {
        sessions.delete(sessionName);
      } else {
        unnamedClients.delete(ws);
      }
    });

    ws.on('error', () => {
      if (sessionName) {
        sessions.delete(sessionName);
      } else {
        unnamedClients.delete(ws);
      }
    });
  });

  server.listen(DAEMON_PORT, '127.0.0.1', () => {
    process.stderr.write(
      `attn: daemon listening on http://127.0.0.1:${DAEMON_PORT}\n`,
    );
  });

  return server;
}
