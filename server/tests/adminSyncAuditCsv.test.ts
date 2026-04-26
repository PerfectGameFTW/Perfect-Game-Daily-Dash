/**
 * Pins behaviour for `GET /api/admin/sync-audit.csv` (Task #117).
 *
 * The endpoint backs the "Download CSV" button on the admin Backfill
 * Audit page. It must:
 *   - share the same auth posture as the JSON browser route
 *     (anonymous → 401, non-admin → 403),
 *   - return text/csv with a `Content-Disposition: attachment`
 *     header so the browser downloads to a file,
 *   - honour the `syncType` filter that the in-app browser applies,
 *   - escape comma / quote / newline content per RFC 4180 so a
 *     mischievous param value can't break out of its CSV column.
 *
 * Modelled on `adminSyncAuditAuth.test.ts`: tiny in-process express
 * app, real `createApiRouter()`, header-driven session shim, real
 * Postgres-backed `pgStorage` so the CSV path is exercised end-to-end.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { eq, inArray } from 'drizzle-orm';

import { db } from '../db';
import { users, syncAudit } from '@shared/schema';
import { authService } from '../services/authService';
import { createApiRouter } from '../routes/api';

const TEST_ADMIN_USERNAME = '__sync_audit_csv_admin__';
const TEST_USER_USERNAME = '__sync_audit_csv_user__';
const STRONG_PASSWORD = 'Str0ng!SyncAuditCsv-Test-9z';
// Synthetic sync types so the assertions don't depend on whatever
// other suites have left in sync_audit.
const TEST_SYNC_TYPE = '__sync_audit_csv_test__';
const OTHER_SYNC_TYPE = '__sync_audit_csv_other__';
// A single field value that would absolutely break a naive CSV
// writer: contains a comma, a double-quote, and a newline. The CSV
// escape contract is what keeps "actor IP" / "params" payloads from
// silently corrupting the export when an operator puts something
// weird in there.
const TROUBLESOME_NOTE = 'comma, "quote", and\nnewline';
// A scalar field value that exercises raw \r\n and quote escaping
// directly (not buried inside JSON.stringify). Goes into
// errorMessage so the CSV writer must wrap and escape the cell
// itself, not just preserve a JSON-encoded substring.
const RAW_MULTILINE_ERROR = 'first line\r\nsecond "quoted" line\nthird,line';
// Begins with `=` — would be evaluated as a formula by Excel /
// Google Sheets if the export didn't neutralize formula-leading
// characters. The audit table holds actor-supplied content
// (usernames, error messages) so this is realistic, not theoretical.
const FORMULA_INJECTION_ERROR = '=cmd|"/c calc"!A1';

interface TestSession {
  userId?: number;
  destroy: (cb?: (err?: Error) => void) => void;
}

interface RequestWithTestSession extends Request {
  session: TestSession;
}

interface RawResp {
  status: number;
  /** Body decoded as UTF-8, with any leading BOM preserved. */
  text: string;
  /** Raw byte length so we can assert the BOM made it onto the wire. */
  bytes: Uint8Array;
  contentType: string | null;
  contentDisposition: string | null;
  cacheControl: string | null;
  rowCount: string | null;
  truncated: string | null;
}

async function getRaw(
  url: string,
  headers: Record<string, string> = {},
): Promise<RawResp> {
  const r = await fetch(url, { headers });
  // Read as bytes, not text(): whatwg fetch's `.text()` silently
  // strips a leading UTF-8 BOM, which would defeat our BOM-on-wire
  // assertion. Decode manually with `ignoreBOM: true` so the BOM
  // round-trips into the JS string for inspection.
  const buf = new Uint8Array(await r.arrayBuffer());
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  return {
    status: r.status,
    text: decoder.decode(buf),
    bytes: buf,
    contentType: r.headers.get('content-type'),
    contentDisposition: r.headers.get('content-disposition'),
    cacheControl: r.headers.get('cache-control'),
    rowCount: r.headers.get('x-sync-audit-row-count'),
    truncated: r.headers.get('x-sync-audit-truncated'),
  };
}

/**
 * Full RFC-4180 CSV parser used only inside this test file. Walks
 * the whole document as a state machine so quoted cells containing
 * raw `\r\n` are kept intact instead of being split across rows by
 * a naive line-by-line approach. Returns `string[][]` — outer array
 * is rows, inner array is cells. A trailing CRLF after the final
 * row is consumed without emitting an empty trailing row.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuotes = false;
  let cellStart = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' && cellStart) {
      inQuotes = true;
      cellStart = false;
      continue;
    }
    if (ch === ',') {
      row.push(cur);
      cur = '';
      cellStart = true;
      continue;
    }
    if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
      cellStart = true;
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
      cellStart = true;
      continue;
    }
    cur += ch;
    cellStart = false;
  }
  // Flush a final partial row that wasn't terminated by CRLF.
  if (cur !== '' || row.length > 0) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

describe('GET /api/admin/sync-audit.csv (Task #117)', () => {
  let server: http.Server;
  let baseUrl: string;
  let adminId: number;
  let userId: number;
  const seededAuditIds: number[] = [];

  beforeAll(async () => {
    await db.delete(users).where(eq(users.username, TEST_ADMIN_USERNAME));
    await db.delete(users).where(eq(users.username, TEST_USER_USERNAME));
    const admin = await authService.registerUser(
      TEST_ADMIN_USERNAME,
      STRONG_PASSWORD,
      'admin',
    );
    adminId = admin.id;
    // Mark admin as TOTP-enrolled so requireAuth skips the mandatory-2FA
    // gate regardless of the global require_admin_2fa toggle. This
    // prevents a race with adminTwoFactor.test.ts (which toggles that
    // setting mid-run) from causing unexpected 403 responses here.
    await db
      .update(users)
      .set({ totpEnabled: true })
      .where(eq(users.id, adminId));
    const user = await authService.registerUser(
      TEST_USER_USERNAME,
      STRONG_PASSWORD,
      'user',
    );
    userId = user.id;

    // Seed three rows under TEST_SYNC_TYPE that together exercise:
    //   - normal happy-path values (start),
    //   - raw multiline / quote / comma scalar content that MUST be
    //     RFC-4180 quoted in a CSV cell (finish.errorMessage), and
    //   - a formula-injection-leading scalar that MUST be neutralized
    //     so Excel/Sheets won't evaluate it (inject.errorMessage).
    // A fourth row under OTHER_SYNC_TYPE proves the syncType filter
    // is honoured end-to-end (must NOT appear in the filtered CSV).
    const inserted = await db
      .insert(syncAudit)
      .values([
        {
          syncType: TEST_SYNC_TYPE,
          action: 'start',
          actorUserId: adminId,
          actorIp: '10.0.0.1',
          params: { note: TROUBLESOME_NOTE },
          status: 'completed',
          result: { processed: 7 },
          pagesUsed: 3,
        },
        {
          syncType: TEST_SYNC_TYPE,
          action: 'finish',
          actorUserId: null,
          actorIp: null,
          params: null,
          status: 'failed',
          errorMessage: RAW_MULTILINE_ERROR,
          pagesUsed: 1,
        },
        {
          syncType: TEST_SYNC_TYPE,
          action: 'inject',
          actorUserId: null,
          actorIp: null,
          status: 'failed',
          errorMessage: FORMULA_INJECTION_ERROR,
        },
        {
          syncType: OTHER_SYNC_TYPE,
          action: 'start',
          actorUserId: adminId,
          actorIp: '10.0.0.2',
          status: 'completed',
        },
      ])
      .returning({ id: syncAudit.id });
    for (const row of inserted) seededAuditIds.push(row.id);

    const app = express();
    app.set('trust proxy', 'loopback');
    app.use(express.json());

    app.use((req: Request, _res: Response, next: NextFunction) => {
      const asUserId = req.headers['x-test-user-id'];
      const session: TestSession = {
        destroy: (cb) => {
          if (cb) cb();
        },
      };
      if (typeof asUserId === 'string' && asUserId !== '') {
        session.userId = Number(asUserId);
      }
      (req as RequestWithTestSession).session = session;
      next();
    });

    app.use('/api', createApiRouter());

    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (seededAuditIds.length > 0) {
      await db.delete(syncAudit).where(inArray(syncAudit.id, seededAuditIds));
    }
    await db.delete(users).where(eq(users.id, adminId));
    await db.delete(users).where(eq(users.id, userId));
  });

  beforeEach(() => {
    authService.invalidateUserCache?.(adminId);
    authService.invalidateUserCache?.(userId);
  });

  it('rejects unauthenticated GET with 401 and no CSV body', async () => {
    const r = await getRaw(`${baseUrl}/api/admin/sync-audit.csv`);
    expect(r.status).toBe(401);
    // Whatever the error shape is, it MUST NOT be the CSV — a leaky
    // refactor that returned text/csv on the error path is exactly
    // what this assertion is here to catch.
    expect(r.contentType ?? '').not.toMatch(/text\/csv/i);
    expect(r.text).not.toContain(TEST_SYNC_TYPE);
  });

  it('rejects logged-in non-admin GET with 403 and no CSV body', async () => {
    const r = await getRaw(`${baseUrl}/api/admin/sync-audit.csv`, {
      'x-test-user-id': String(userId),
    });
    expect(r.status).toBe(403);
    expect(r.contentType ?? '').not.toMatch(/text\/csv/i);
    expect(r.text).not.toContain(TEST_SYNC_TYPE);
  });

  it('returns text/csv with attachment headers and the seeded rows for an admin', async () => {
    const qs = new URLSearchParams({ syncType: TEST_SYNC_TYPE }).toString();
    const r = await getRaw(`${baseUrl}/api/admin/sync-audit.csv?${qs}`, {
      'x-test-user-id': String(adminId),
    });
    expect(r.status).toBe(200);
    expect(r.contentType ?? '').toMatch(/text\/csv/i);
    expect(r.contentType ?? '').toMatch(/charset=utf-8/i);
    expect(r.contentDisposition ?? '').toMatch(/^attachment;/);
    // Filename should look like sync-audit-YYYY-MM-DD.csv so multiple
    // downloads in a session don't collide in the user's downloads
    // folder.
    expect(r.contentDisposition ?? '').toMatch(
      /filename="sync-audit-\d{4}-\d{2}-\d{2}\.csv"/,
    );
    // Cache-Control: no-store so a stale CSV can't be served by an
    // intermediate or remembered by the browser.
    expect(r.cacheControl ?? '').toMatch(/no-store/i);
    // Truncation/row-count headers: when the export fits under the
    // cap (default 10k, well above our 3 seeded rows) the truncated
    // signal must be `false` and the row count must match the
    // visible body. Operators rely on this to tell a complete export
    // from a partial one.
    expect(r.truncated).toBe('false');
    expect(r.rowCount).toBe('3');

    // Body sanity: starts with UTF-8 BOM (Excel cue for unicode),
    // then the column header line, then one line per matching row +
    // a trailing CRLF. Assert against the raw bytes — fetch's
    // `.text()` decoder silently swallows a leading BOM, which would
    // make a missing BOM look like a passing test.
    expect(Array.from(r.bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    expect(r.text.charCodeAt(0)).toBe(0xfeff);
    const noBom = r.text.slice(1);

    // Use a real RFC-4180 parser, NOT a CRLF split, so multiline
    // quoted cells (the finish.errorMessage row) stay intact.
    const csvRows = parseCsv(noBom);
    expect(csvRows.length).toBe(1 + 3); // header + 3 seeded rows under TEST_SYNC_TYPE

    const header = csvRows[0];
    expect(header).toEqual([
      'id',
      'syncType',
      'action',
      'actorUsername',
      'actorUserId',
      'actorIp',
      'status',
      'pagesUsed',
      'startedAt',
      'completedAt',
      'params',
      'result',
      'errorMessage',
    ]);

    // Locate the seeded rows by `action` since they share syncType.
    const dataRows = csvRows.slice(1);
    const startRow = dataRows.find((cells) => cells[2] === 'start');
    const finishRow = dataRows.find((cells) => cells[2] === 'finish');
    const injectRow = dataRows.find((cells) => cells[2] === 'inject');
    expect(startRow).toBeDefined();
    expect(finishRow).toBeDefined();
    expect(injectRow).toBeDefined();

    // The CSV-troublesome `note` value should round-trip exactly
    // through quote-escape — including the embedded newline and the
    // doubled quote. Comes through wrapped in a JSON-stringified
    // params blob since the column is a JSON cell.
    expect(startRow![10]).toBe(JSON.stringify({ note: TROUBLESOME_NOTE }));
    expect(startRow![3]).toBe(TEST_ADMIN_USERNAME);
    expect(startRow![4]).toBe(String(adminId));
    expect(startRow![5]).toBe('10.0.0.1');
    expect(startRow![6]).toBe('completed');
    expect(startRow![7]).toBe('3');
    // Started timestamp should be ISO-8601 (Z-suffixed UTC).
    expect(startRow![8]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    // The "finish" row was seeded with no actor and no params, so
    // those cells must be empty (NOT the literal string "null").
    expect(finishRow![3]).toBe(''); // actorUsername
    expect(finishRow![4]).toBe(''); // actorUserId
    expect(finishRow![5]).toBe(''); // actorIp
    expect(finishRow![10]).toBe(''); // params
    expect(finishRow![6]).toBe('failed');
    // Raw scalar with \r\n / \n / quote / comma all in one cell —
    // the parser only got it back intact because the writer wrapped
    // the cell in quotes and doubled the embedded quote, per RFC 4180.
    expect(finishRow![12]).toBe(RAW_MULTILINE_ERROR);

    // CSV formula injection guard: the seeded errorMessage starts
    // with `=`, which Excel/Sheets would treat as a formula. The
    // export must prefix a single quote so the cell stays text.
    expect(injectRow![12]).toBe(`'${FORMULA_INJECTION_ERROR}`);
    expect(injectRow![12].startsWith('=')).toBe(false);

    // The OTHER_SYNC_TYPE row must NOT appear when the syncType
    // filter is set — proves the filter is honoured end-to-end.
    expect(noBom).not.toContain(OTHER_SYNC_TYPE);
  });

  it('returns all seeded rows (across both sync types) when no filter is supplied', async () => {
    const r = await getRaw(`${baseUrl}/api/admin/sync-audit.csv`, {
      'x-test-user-id': String(adminId),
    });
    expect(r.status).toBe(200);
    // Both synthetic types should be present; this also doubles as a
    // smoke test that the unfiltered code path works without throwing.
    expect(r.text).toContain(TEST_SYNC_TYPE);
    expect(r.text).toContain(OTHER_SYNC_TYPE);
  });

  it('rejects an oversized syncType filter with 400 and no CSV body', async () => {
    const qs = new URLSearchParams({ syncType: 'x'.repeat(500) }).toString();
    const r = await getRaw(`${baseUrl}/api/admin/sync-audit.csv?${qs}`, {
      'x-test-user-id': String(adminId),
    });
    expect(r.status).toBe(400);
    expect(r.contentType ?? '').not.toMatch(/text\/csv/i);
  });

  it('signals truncation when more matching rows exist than the export cap', async () => {
    // Three rows under TEST_SYNC_TYPE were seeded; force the export
    // cap down to 2 so the third row gets dropped. Without the
    // truncation header an operator would have no way to tell their
    // "complete" download is actually missing audit history — the
    // exact failure mode this header exists to surface.
    const qs = new URLSearchParams({
      syncType: TEST_SYNC_TYPE,
      maxRows: '2',
    }).toString();
    const r = await getRaw(`${baseUrl}/api/admin/sync-audit.csv?${qs}`, {
      'x-test-user-id': String(adminId),
    });
    expect(r.status).toBe(200);
    expect(r.contentType ?? '').toMatch(/text\/csv/i);
    expect(r.truncated).toBe('true');
    expect(r.rowCount).toBe('2');

    // The body should contain exactly the cap number of data rows
    // (2) plus the header row, NOT cap+1 — i.e. the route must drop
    // the probe row before rendering the CSV.
    const noBom = r.text.slice(1);
    const csvRows = parseCsv(noBom);
    expect(csvRows.length).toBe(1 + 2);
  });

  it('rejects an out-of-range maxRows with 400 and no CSV body', async () => {
    const qs = new URLSearchParams({ maxRows: '0' }).toString();
    const r = await getRaw(`${baseUrl}/api/admin/sync-audit.csv?${qs}`, {
      'x-test-user-id': String(adminId),
    });
    expect(r.status).toBe(400);
    expect(r.contentType ?? '').not.toMatch(/text\/csv/i);
  });
});
