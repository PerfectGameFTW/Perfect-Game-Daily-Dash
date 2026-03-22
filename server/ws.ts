import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';

let wss: WebSocketServer | null = null;

export function initWebSocket(server: Server): void {
  wss = new WebSocketServer({ server, path: '/ws' });

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
