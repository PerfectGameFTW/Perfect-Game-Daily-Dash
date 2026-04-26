/**
 * Unit-test matrix for `samePostgresEndpoint` (Task #141).
 *
 * The helper protects the test-DB audit (Task #138) from accidentally
 * connecting to the live database when the resolved test URL is
 * actually the live URL written in a slightly different surface form.
 * A future refactor that, e.g., forgets to lowercase the host or
 * stops decoding the username could silently downgrade the safety
 * guarantee from "canonical-equality" back to "byte-equality" without
 * breaking any visible test. This matrix locks in the canonical-
 * equality contract so any such regression is caught at PR time.
 *
 * Each `it.each` block has one row per case described in the task:
 * the "same" block covers every shape that MUST collapse to a single
 * canonical endpoint, the "not same" block covers every dimension
 * the comparator must remain sensitive to, and the unparseable case
 * pins the conservative-fallback contract.
 */

import { describe, it, expect } from 'vitest';
import { samePostgresEndpoint } from './samePostgresEndpoint';

describe('samePostgresEndpoint', () => {
  describe('returns true when both URLs describe the same Postgres endpoint', () => {
    // Each row is [name, a, b]. The helper must collapse every
    // surface-form variation in this table to a single canonical
    // endpoint and return true. If a row starts returning false,
    // the audit safety guard has been weakened and that change must
    // be either reverted or accompanied by a deliberate update to
    // both this test and the helper's contract docstring.
    const sameCases: Array<[string, string, string]> = [
      [
        'identical URLs',
        'postgres://alice:secret@db.example.com:5432/app?ssl=true',
        'postgres://alice:secret@db.example.com:5432/app?ssl=true',
      ],
      [
        'reordered query parameters',
        'postgres://alice:secret@db.example.com:5432/app?ssl=true&channel_binding=require',
        'postgres://alice:secret@db.example.com:5432/app?channel_binding=require&ssl=true',
      ],
      [
        'different percent-encoding of username',
        // 'al%69ce' decodes to 'alice'. The helper runs
        // decodeURIComponent on the username before comparing, so
        // both sides should normalize to the same canonical user.
        'postgres://al%69ce:secret@db.example.com:5432/app',
        'postgres://alice:secret@db.example.com:5432/app',
      ],
      [
        'different host case',
        'postgres://alice:secret@DB.Example.COM:5432/app',
        'postgres://alice:secret@db.example.com:5432/app',
      ],
      [
        'explicit :5432 vs default port',
        // The default Postgres port is 5432; the helper substitutes
        // '5432' when u.port is the empty string so the explicit
        // and implicit forms canonicalize identically.
        'postgres://alice:secret@db.example.com:5432/app',
        'postgres://alice:secret@db.example.com/app',
      ],
      [
        'trailing slash on database path',
        // The helper strips a leading and a trailing slash from
        // pathname before extracting the database name. A stray
        // trailing slash on one side must not cause a false negative.
        'postgres://alice:secret@db.example.com:5432/app/',
        'postgres://alice:secret@db.example.com:5432/app',
      ],
      [
        'different password (passwords are not part of the endpoint identity)',
        // Two strings can carry different passwords yet describe the
        // same endpoint — e.g. before/after a password rotation. The
        // helper intentionally ignores the password (it is not part
        // of "what database am I connecting to") so a rotation
        // window cannot create a temporary safety hole.
        'postgres://alice:oldpass@db.example.com:5432/app',
        'postgres://alice:newpass@db.example.com:5432/app',
      ],
    ];

    it.each(sameCases)('%s', (_name, a, b) => {
      expect(samePostgresEndpoint(a, b)).toBe(true);
      // The relation must also be symmetric — a future refactor that
      // accidentally compares only one direction would still pass
      // the rows above without this assertion.
      expect(samePostgresEndpoint(b, a)).toBe(true);
    });
  });

  describe('returns false when URLs describe different endpoints', () => {
    // Each row is [name, a, b]. These pin the dimensions the
    // comparator must remain sensitive to: differ along ANY of
    // host / port / database / user and the audit MUST be willing
    // to open the connection (because it is, by definition, a
    // different database than the live one).
    const differentCases: Array<[string, string, string]> = [
      [
        'different host',
        'postgres://alice:secret@db.example.com:5432/app',
        'postgres://alice:secret@db.other.com:5432/app',
      ],
      [
        'different explicit port',
        'postgres://alice:secret@db.example.com:5432/app',
        'postgres://alice:secret@db.example.com:6543/app',
      ],
      [
        'different database name',
        'postgres://alice:secret@db.example.com:5432/app',
        'postgres://alice:secret@db.example.com:5432/app_test',
      ],
      [
        'different username',
        'postgres://alice:secret@db.example.com:5432/app',
        'postgres://bob:secret@db.example.com:5432/app',
      ],
    ];

    it.each(differentCases)('%s', (_name, a, b) => {
      expect(samePostgresEndpoint(a, b)).toBe(false);
      expect(samePostgresEndpoint(b, a)).toBe(false);
    });
  });

  describe('conservative fallback for unparseable input', () => {
    // The contract is "if either URL is unparseable, return true so
    // the caller refuses to connect." Any change that flips this to
    // false would let the audit open a connection to a string it
    // could not reason about, which is the exact failure mode the
    // helper exists to prevent.
    const unparseableCases: Array<[string, string, string]> = [
      [
        'left side is garbage',
        'this is not a url',
        'postgres://alice:secret@db.example.com:5432/app',
      ],
      [
        'right side is garbage',
        'postgres://alice:secret@db.example.com:5432/app',
        'definitely-not-a-url',
      ],
      ['both sides are garbage', 'nope', 'also nope'],
      ['empty strings', '', ''],
    ];

    it.each(unparseableCases)('%s → returns true (refuse to audit)', (_name, a, b) => {
      expect(samePostgresEndpoint(a, b)).toBe(true);
    });
  });
});
