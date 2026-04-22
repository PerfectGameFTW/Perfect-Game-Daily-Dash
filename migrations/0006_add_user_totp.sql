-- Task #56: TOTP second factor for admin sign-in.
--
-- Adds three columns to the users table:
--   * totp_secret_encrypted — AES-256-GCM envelope of the base32 TOTP
--     secret (see server/services/totpCrypto.ts). NULL means "no
--     pending or active enrollment".
--   * totp_enabled — flips to true only after the user verifies their
--     first 6-digit code; until then the secret is ignored at login.
--   * totp_recovery_codes — array of bcrypt hashes, one per remaining
--     one-time recovery code. Codes are removed from the array as
--     they are consumed.
--
-- All three are nullable / default-safe so existing rows continue
-- working unchanged with 2FA off.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS totp_secret_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS totp_recovery_codes TEXT[];
