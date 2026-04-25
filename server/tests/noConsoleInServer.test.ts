/**
 * Guard test (Task #111) — pins the structured-logger discipline that
 * Tasks #81 and #110 hand-converted ~400 raw console.* calls to honor.
 *
 * Replit workspace logs are visible to anyone with workspace access, so
 * a `console.log(customer)` slipped into a route handler can leak names,
 * emails, and gift-card numbers to anyone with the workspace URL. This
 * test fails the build whenever a new raw console call appears under
 * `server/` without an explicit allow-list comment, so a future PR
 * cannot silently re-introduce the leak vector.
 *
 * If you intentionally need a console.* call (e.g. a bootstrap-time
 * writer that runs before the structured logger is wired up — see
 * `server/vite.ts`), add an `eslint-disable-next-line no-console`
 * comment on the same or preceding line with a short rationale.
 * File-level `eslint-disable no-console` directives are also honored
 * for the rare module that intentionally writes to stdout/stderr only.
 *
 * The check is implemented as a vitest test (rather than wiring up
 * ESLint) because the project doesn't ship an ESLint toolchain and
 * `package.json` is off-limits per the project dev guidelines, but
 * `npm test` already runs in CI and on every contributor's machine.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';

const SERVER_ROOT = join(process.cwd(), 'server');
const SELF_PATH = fileURLToPath(import.meta.url);

// Match an actual call site, not a bare reference. Requires an open
// paren so a doc comment that says "see console.log calls" is ignored
// — only `console.log(...)` form is flagged.
const CONSOLE_CALL = /\bconsole\.(log|info|warn|error|debug|trace)\s*\(/;

// Standard ESLint directive forms. We accept either the inline form
// (`// eslint-disable-next-line no-console`) sitting on the same line
// or the immediately preceding comment block, or a file-level
// directive (`/* eslint-disable no-console */`) declared earlier in
// the file.
const DISABLE_DIRECTIVE = /eslint-disable(-next-line|-line)?[^\n]*\bno-console\b/;

const SKIP_DIRS = new Set(['node_modules']);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
    } else if (
      // `server/` is TypeScript today, but defensively cover any
      // future `.tsx`, `.js`, `.mjs`, or `.cjs` source so a contributor
      // adding a one-off helper script can't sneak past the guard.
      // `.d.ts` is excluded because it's type-only — no runtime code.
      (full.endsWith('.ts') ||
        full.endsWith('.tsx') ||
        full.endsWith('.js') ||
        full.endsWith('.mjs') ||
        full.endsWith('.cjs')) &&
      !full.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return (
    t.startsWith('//') ||
    t.startsWith('/*') ||
    t.startsWith('*') ||
    t.startsWith('*/')
  );
}

function findUnjustifiedConsole(): string[] {
  const violations: string[] = [];
  const files = walk(SERVER_ROOT);

  for (const file of files) {
    // Skip this guard file itself — its source intentionally describes
    // the regex it's enforcing and would otherwise self-flag.
    if (file === SELF_PATH) continue;

    const text = readFileSync(file, 'utf8');
    const lines = text.split(/\r?\n/);

    // File-level disable: an `eslint-disable no-console` (no `-next-line`
    // qualifier) declared in the file's leading section turns the rule
    // off for the entire file. We only honor this when it appears in
    // the first 50 lines, where module-scoped pragmas live, so that a
    // single buried `eslint-disable` deeper in a file can't accidentally
    // suppress everything below it.
    const header = lines.slice(0, 50).join('\n');
    const fileLevelDisable =
      /eslint-disable(?!-next-line|-line)[^\n]*\bno-console\b/.test(header);
    if (fileLevelDisable) continue;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!CONSOLE_CALL.test(line)) continue;
      // Comment-only line — `// example: console.log(x)` in a doc block
      // is documentation, not a call site. Ignore it.
      if (isCommentLine(line)) continue;
      // Inline `eslint-disable-line no-console` on the offending line.
      if (DISABLE_DIRECTIVE.test(line)) continue;
      // `eslint-disable-next-line no-console` on the preceding line.
      // Walk back through any contiguous `//` rationale block so the
      // directive may sit on the FIRST line of a multi-line comment.
      let prev = i - 1;
      while (prev >= 0 && lines[prev].trim() === '') prev--;
      let directiveFound = false;
      while (prev >= 0 && isCommentLine(lines[prev])) {
        if (DISABLE_DIRECTIVE.test(lines[prev])) {
          directiveFound = true;
          break;
        }
        prev--;
      }
      if (directiveFound) continue;

      violations.push(`${relative(process.cwd(), file)}:${i + 1}: ${line.trim()}`);
    }
  }

  return violations;
}

describe('no raw console.* under server/ (Task #111)', () => {
  it('every console.* call must use the structured logger or carry an eslint-disable no-console rationale', () => {
    const violations = findUnjustifiedConsole();
    if (violations.length > 0) {
      throw new Error(
        'Unjustified console.* call(s) found under server/. ' +
          'Use the structured logger from server/logger.ts (logger.info / logger.warn / logger.error with errorContext()), ' +
          'or, if a console call is genuinely required, add an `eslint-disable-next-line no-console` comment with a short rationale ' +
          '(see server/vite.ts for the canonical pattern).\n\n' +
          violations.map((v) => `  - ${v}`).join('\n'),
      );
    }
    expect(violations).toEqual([]);
  });
});
