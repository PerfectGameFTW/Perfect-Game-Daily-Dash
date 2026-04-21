import type { IncomingHttpHeaders, IncomingMessage } from "http";
import type { Request } from "express";

type HeaderSource =
  | Request
  | IncomingMessage
  | { headers: IncomingHttpHeaders };

/**
 * Shared same-origin helper used by CSRF and (eventually) the
 * WebSocket origin check. Defines what counts as an "allowed" Origin
 * for state-changing requests against this server.
 *
 * Rules:
 *  - No Origin header → allowed. Browsers omit Origin on top-level
 *    same-origin GETs and on simple form posts; the CSRF caller is
 *    responsible for layering a custom-header check (e.g.
 *    `x-requested-with: XMLHttpRequest`) on top of this.
 *  - Origin host matches the request's Host header → allowed
 *    (true same-origin requests from our own dashboard).
 *  - Origin appears in the comma-separated `ALLOWED_ORIGINS`
 *    environment variable → allowed (escape hatch for reverse
 *    proxies / preview domains).
 *  - Anything else → rejected.
 */
function parseAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter((s) => s.length > 0);
}

export function isAllowedOrigin(req: HeaderSource): boolean {
  const originHeader = req.headers.origin;
  if (!originHeader || typeof originHeader !== "string") {
    return true;
  }
  const origin = originHeader.replace(/\/$/, "");

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  const host = req.headers.host;
  if (host && parsed.host.toLowerCase() === host.toLowerCase()) {
    return true;
  }

  const allowList = parseAllowedOrigins();
  return allowList.includes(origin);
}
