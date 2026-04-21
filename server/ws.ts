import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'http';
import { isAllowedOrigin } from './security/origin';

let wss: WebSocketServer | null = null;

export function initWebSocket(server: Server): void {
  wss = new WebSocketServer({
    server,
    path: '/ws',
    // Origin allow-list using the same helper as the HTTP CSRF /mcp
    // checks, so /api, /mcp, and /ws all share one definition of
    // "this origin is allowed to talk to the server". Auth, message
    // caps, and heartbeats are deferred to the dedicated WebSocket
    // hardening task.
    verifyClient: ({ req }: { req: IncomingMessage }) => {
      return isAllowedOrigin(req);
    },
  });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'connected' }));

    ws.on('error', (err) => {
      console.error('[WS] Client error:', err.message);
    });
  });
}

export function broadcast(event: string, data?: Record<string, unknown>): void {
  if (!wss) return;
  const message = JSON.stringify({ type: event, ...data });
  for (const client of Array.from(wss.clients)) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}
