import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import { isAllowedOrigin } from './security/origin';
import { sessionMiddleware, legacyCookieCompatMiddleware } from './session';

// Per-source concurrent connection cap.
//
// `clientIp()` returns the TCP peer (the trusted upstream proxy in any
// real deployment), so this cap is effectively "concurrent WS sockets
// per upstream proxy address". That means EVERY legitimate user behind
// the same edge shares this bucket — set it generously so normal usage
// never trips it, and rely on the per-user cap below to block one
// account from monopolizing the budget.
const MAX_CONNECTIONS_PER_SOURCE = 500;

// Per-authenticated-user concurrent connection cap. This is the real
// abuse control: it stops a single compromised or runaway account from
// opening hundreds of sockets and exhausting the WS process. A normal
// user has 1–4 tabs open; 25 leaves comfortable headroom for
// reconnect storms without enabling a single-account DoS.
const MAX_CONNECTIONS_PER_USER = 25;

// Heartbeat: ping every 30s, terminate any socket that hasn't
// answered the previous ping by the next interval. Prunes dead
// clients (laptop closed, NAT timeout, broken proxies) without
// waiting for the OS TCP keepalive.
const HEARTBEAT_INTERVAL_MS = 30_000;

interface TaggedSocket extends WebSocket {
  _ip?: string;
  _userId?: number;
  _isAlive?: boolean;
}

let wss: WebSocketServer | null = null;
const ipCounts = new Map<string, number>();
const userCounts = new Map<number, number>();

// Resolve the client IP for the per-IP WebSocket connection cap.
//
// SECURITY: We deliberately do NOT parse `X-Forwarded-For` here. The
// leftmost XFF entry is fully attacker-controlled, and the WebSocket
// upgrade path bypasses Express's `trust proxy` policy that would
// otherwise pick the right entry from the right end of the chain. A
// naive leftmost read lets a single attacker rotate XFF per request and
// trivially bypass the per-IP cap.
//
// `req.socket.remoteAddress` is the TCP peer of the upgrade — behind a
// trusted edge (Replit, Cloudflare, an in-cluster proxy) that's the
// proxy itself, so the cap effectively becomes "N concurrent WS
// connections per upstream proxy". That's the correct behavior for an
// abuse cap behind a fixed reverse-proxy fleet, and it cannot be spoofed
// by the end client. Per-real-client caps would require trusting a
// signed proxy header that this deployment does not currently emit.
function clientIp(req: IncomingMessage): string {
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
    if (current >= MAX_CONNECTIONS_PER_SOURCE) {
      return rejectUpgrade(socket, '429 Too Many Requests');
    }

    runSessionMiddleware(req)
      .then(() => {
        const session = (req as any).session;
        if (!session || !session.userId) {
          return rejectUpgrade(socket, '401 Unauthorized');
        }

        const userId = session.userId as number;
        // Per-user cap. Re-checked here (not at the IP-cap site) because
        // we don't know the userId until after session lookup. The
        // counter is bumped inside handleUpgrade to keep increment +
        // close-decrement symmetrical.
        const userOpen = userCounts.get(userId) ?? 0;
        if (userOpen >= MAX_CONNECTIONS_PER_USER) {
          return rejectUpgrade(socket, '429 Too Many Requests');
        }

        wss!.handleUpgrade(req, socket, head, (ws) => {
          const tagged = ws as TaggedSocket;
          tagged._ip = ip;
          tagged._userId = userId;
          tagged._isAlive = true;
          ipCounts.set(ip, (ipCounts.get(ip) ?? 0) + 1);
          userCounts.set(userId, (userCounts.get(userId) ?? 0) + 1);
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
      if (ip) {
        const nextIp = (ipCounts.get(ip) ?? 1) - 1;
        if (nextIp <= 0) ipCounts.delete(ip);
        else ipCounts.set(ip, nextIp);
      }
      const userId = ws._userId;
      if (typeof userId === 'number') {
        const nextUser = (userCounts.get(userId) ?? 1) - 1;
        if (nextUser <= 0) userCounts.delete(userId);
        else userCounts.set(userId, nextUser);
      }
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

export function closeWebSocket(): Promise<void> {
  return new Promise((resolve) => {
    if (!wss) return resolve();
    const server = wss;
    wss = null;
    for (const client of Array.from(server.clients)) {
      try {
        client.terminate();
      } catch {
        // ignore — best effort during shutdown
      }
    }
    server.close(() => resolve());
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
