import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import { isAllowedOrigin } from './security/origin';
import { sessionMiddleware, legacyCookieCompatMiddleware } from './session';

// Per-IP concurrent connection cap. Small enough to make connection-
// exhaustion DoS uninteresting, large enough that a logged-in admin
// with multiple browser tabs / a quick reconnect doesn't lock
// themselves out.
const MAX_CONNECTIONS_PER_IP = 10;

// Heartbeat: ping every 30s, terminate any socket that hasn't
// answered the previous ping by the next interval. Prunes dead
// clients (laptop closed, NAT timeout, broken proxies) without
// waiting for the OS TCP keepalive.
const HEARTBEAT_INTERVAL_MS = 30_000;

interface TaggedSocket extends WebSocket {
  _ip?: string;
  _isAlive?: boolean;
}

let wss: WebSocketServer | null = null;
const ipCounts = new Map<string, number>();

function clientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  if (Array.isArray(xff) && xff.length > 0) {
    return xff[0].split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function rejectUpgrade(socket: Duplex, statusLine: string): void {
  try {
    socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`);
  } catch {
    // ignore write errors on a half-broken socket
  }
  socket.destroy();
}

function runSessionMiddleware(req: IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    // express-session expects a (req, res, next) signature. The
    // upgrade request has no Express response, but the middleware
    // only touches res when it needs to set a cookie — which it
    // won't on a session lookup that doesn't mutate session data.
    // Provide a minimal stub that swallows header writes.
    const fakeRes: any = {
      getHeader: () => undefined,
      setHeader: () => fakeRes,
      removeHeader: () => undefined,
      on: () => fakeRes,
      once: () => fakeRes,
      emit: () => false,
      end: () => fakeRes,
      writeHead: () => fakeRes,
      write: () => true,
      headersSent: false,
    };
    // Run the legacy cookie compat shim first so previously-issued
    // `pg.sid` cookies are still honored under the hardened
    // `__Host-pg.sid` name on the WebSocket upgrade path too.
    legacyCookieCompatMiddleware(req as any, fakeRes, () => {
      sessionMiddleware(req as any, fakeRes, (err?: unknown) => {
        if (err) reject(err as Error);
        else resolve();
      });
    });
  });
}

export function initWebSocket(server: Server): void {
  wss = new WebSocketServer({ noServer: true });

  // Manual upgrade handler. We do every check (origin, auth, per-IP
  // cap) BEFORE letting `ws` complete the handshake so a rejected
  // client never gets a 101 Switching Protocols and never reaches
  // the broadcast set.
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws' && !req.url?.startsWith('/ws?')) {
      // Not our endpoint — leave it for other upgrade listeners
      // (e.g. Vite HMR in dev). Returning here is critical: calling
      // socket.destroy() would kill HMR.
      return;
    }

    if (!isAllowedOrigin(req)) {
      return rejectUpgrade(socket, '403 Forbidden');
    }

    const ip = clientIp(req);
    const current = ipCounts.get(ip) ?? 0;
    if (current >= MAX_CONNECTIONS_PER_IP) {
      return rejectUpgrade(socket, '429 Too Many Requests');
    }

    runSessionMiddleware(req)
      .then(() => {
        const session = (req as any).session;
        if (!session || !session.userId) {
          return rejectUpgrade(socket, '401 Unauthorized');
        }

        wss!.handleUpgrade(req, socket, head, (ws) => {
          const tagged = ws as TaggedSocket;
          tagged._ip = ip;
          tagged._isAlive = true;
          ipCounts.set(ip, (ipCounts.get(ip) ?? 0) + 1);
          wss!.emit('connection', tagged, req);
        });
      })
      .catch((err) => {
        console.error('[WS] Session lookup failed during upgrade:', err);
        rejectUpgrade(socket, '500 Internal Server Error');
      });
  });

  wss.on('connection', (ws: TaggedSocket) => {
    ws.send(JSON.stringify({ type: 'connected' }));

    ws.on('pong', () => {
      ws._isAlive = true;
    });

    ws.on('close', () => {
      const ip = ws._ip;
      if (!ip) return;
      const next = (ipCounts.get(ip) ?? 1) - 1;
      if (next <= 0) ipCounts.delete(ip);
      else ipCounts.set(ip, next);
    });

    ws.on('error', (err) => {
      console.error('[WS] Client error:', err.message);
    });
  });

  // Heartbeat sweeper. If a client failed to pong since the last
  // tick, terminate it; otherwise mark it dead and ping again. The
  // close handler above will decrement the per-IP counter.
  const heartbeat = setInterval(() => {
    if (!wss) return;
    for (const client of Array.from(wss.clients)) {
      const tagged = client as TaggedSocket;
      if (tagged._isAlive === false) {
        try { tagged.terminate(); } catch { /* ignore */ }
        continue;
      }
      tagged._isAlive = false;
      try { tagged.ping(); } catch { /* ignore */ }
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  wss.on('close', () => {
    clearInterval(heartbeat);
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
