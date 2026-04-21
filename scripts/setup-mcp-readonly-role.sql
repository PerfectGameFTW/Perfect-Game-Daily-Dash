-- =====================================================================
-- MCP run_read_query: full DB-level lockdown for the read-only role
-- =====================================================================
-- Run this script ONCE per environment, as a Postgres SUPERUSER (or as
-- the role that owns the system catalogs / information_schema). On Neon
-- and other managed Postgres providers, run it from the provider's SQL
-- console using the privileged admin connection string.
--
-- Why this script exists:
--   Task #53 requires the dedicated `mcp_read_only` role to be denied
--   access to system catalogs and `information_schema` at the Postgres
--   permission layer (not just by the application-side parser/keyword
--   filter). Default Postgres installs grant SELECT on those views to
--   PUBLIC, and PUBLIC's grants can only be revoked by the role that
--   originally granted them — which on managed providers is a platform
--   superuser, not the application's database-owner role. The
--   application's runtime `ensureMcpReadRole()` therefore cannot revoke
--   those grants on its own; this script does so explicitly so an
--   operator can complete the lockdown.
--
-- Idempotent: re-running this script is safe.
-- =====================================================================

-- 1. Ensure the role exists (NOLOGIN, NOINHERIT — strictly a
--    permission bucket switched into via SET LOCAL ROLE).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_read_only') THEN
    CREATE ROLE mcp_read_only NOLOGIN NOINHERIT;
  END IF;
END$$;

-- 2. Grant SELECT only on the seven business tables.
GRANT USAGE ON SCHEMA public TO mcp_read_only;
GRANT SELECT ON public.orders             TO mcp_read_only;
GRANT SELECT ON public.order_line_items   TO mcp_read_only;
GRANT SELECT ON public.transactions       TO mcp_read_only;
GRANT SELECT ON public.gift_cards         TO mcp_read_only;
GRANT SELECT ON public.refunds            TO mcp_read_only;
GRANT SELECT ON public.intercard_revenue  TO mcp_read_only;
GRANT SELECT ON public.payout_fee_entries TO mcp_read_only;

-- 3. Revoke PUBLIC's default grants on the sensitive system catalog
--    views and on information_schema. Because mcp_read_only is
--    NOINHERIT and has no direct grants on these, removing PUBLIC's
--    grant denies it access. The other application roles that need
--    metadata access are re-granted explicitly afterward.
REVOKE SELECT ON pg_catalog.pg_user           FROM PUBLIC;
REVOKE SELECT ON pg_catalog.pg_shadow         FROM PUBLIC;
REVOKE SELECT ON pg_catalog.pg_stat_activity  FROM PUBLIC;
REVOKE SELECT ON pg_catalog.pg_settings       FROM PUBLIC;
REVOKE SELECT ON pg_catalog.pg_authid         FROM PUBLIC;
REVOKE USAGE ON SCHEMA information_schema     FROM PUBLIC;
REVOKE SELECT ON ALL TABLES IN SCHEMA information_schema FROM PUBLIC;

-- 4. Re-grant the privileges the regular application database-owner
--    role needs. Replace `:app_role` with the actual role name in
--    your DATABASE_URL (e.g. `neondb_owner`, `postgres`) before
--    running this section.
\set app_role neondb_owner

GRANT SELECT ON pg_catalog.pg_user           TO :app_role;
GRANT SELECT ON pg_catalog.pg_shadow         TO :app_role;
GRANT SELECT ON pg_catalog.pg_stat_activity  TO :app_role;
GRANT SELECT ON pg_catalog.pg_settings       TO :app_role;
GRANT USAGE  ON SCHEMA information_schema    TO :app_role;
GRANT SELECT ON ALL TABLES IN SCHEMA information_schema TO :app_role;

-- 5. Membership so the application role can `SET LOCAL ROLE
--    mcp_read_only` from inside its read-only transactions.
GRANT mcp_read_only TO :app_role;
