-- WBS-TF-07 — production Neon migration for the Dashboard dedicated role.
--
-- Separately reviewed owner migration. NOT the staging-only
-- sql/dashboard_role_staging.sql. Guarded against accidental staging
-- execution by refusing to run unless -v production_branch_confirmed=on.
--
-- Executed as neondb_owner on the production Neon branch. Password is
-- read from the process environment variable WBS_DASHBOARD_PROD_ROLE_PASSWORD
-- and never echoed to stdout. Role creation, function install, ACLs
-- and assertions run in one transaction; any failure rolls all back.
\set ON_ERROR_STOP on

\if :{?production_branch_confirmed}
  \if :production_branch_confirmed
  \else
    DO $deny$ BEGIN RAISE EXCEPTION 'Refusing production migration: production_branch_confirmed is false'; END $deny$;
  \endif
\else
  DO $deny$ BEGIN RAISE EXCEPTION 'Refusing production migration: pass -v production_branch_confirmed=on'; END $deny$;
\endif

\getenv dashboard_password WBS_DASHBOARD_PROD_ROLE_PASSWORD
\if :{?dashboard_password}
\else
  DO $deny$ BEGIN RAISE EXCEPTION 'Refusing production migration: set WBS_DASHBOARD_PROD_ROLE_PASSWORD in the process environment'; END $deny$;
\endif
SELECT length(:'dashboard_password') >= 24 AS dashboard_password_ok \gset
\if :dashboard_password_ok
\else
  DO $deny$ BEGIN RAISE EXCEPTION 'Refusing production migration: dashboard password is too short'; END $deny$;
\endif

-- Early sanity checks: schema must exist and be owned by neondb_owner,
-- and the role must not already exist (replays after rollback are a
-- separate operation).
BEGIN;
DO $pre$
BEGIN
  IF current_database() <> 'neondb' OR current_user <> 'neondb_owner' THEN
    RAISE EXCEPTION 'expected neondb as neondb_owner';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'trade_fair') THEN
    RAISE EXCEPTION 'trade_fair schema missing on this branch';
  END IF;
  IF (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname='trade_fair') <> 'neondb_owner' THEN
    RAISE EXCEPTION 'trade_fair schema owner is not neondb_owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='trade_fair_dashboard') THEN
    RAISE EXCEPTION 'trade_fair_dashboard role already exists; audit first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='trade_fair' AND p.proname='dashboard_snapshot') THEN
    RAISE EXCEPTION 'trade_fair.dashboard_snapshot already exists; audit first';
  END IF;
END
$pre$;

CREATE ROLE trade_fair_dashboard LOGIN PASSWORD :'dashboard_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;

GRANT CONNECT ON DATABASE neondb TO trade_fair_dashboard;

-- Resolve from this script's directory, independent of the caller's cwd.
-- The shared definition has no BEGIN/COMMIT or grants.
\ir ../dashboard_snapshot_definition.sql
REVOKE ALL ON FUNCTION trade_fair.dashboard_snapshot(integer,integer,text,text,text,text,text,text,text) FROM PUBLIC;
GRANT USAGE ON SCHEMA trade_fair TO trade_fair_dashboard;
GRANT EXECUTE ON FUNCTION trade_fair.dashboard_snapshot(integer,integer,text,text,text,text,text,text,text) TO trade_fair_dashboard;

-- Verify privileges BEFORE commit so an assertion failure rolls back
-- role creation, function creation, revocation and grants together.
DO $post$
DECLARE r RECORD;
BEGIN
  SELECT prosecdef, provolatile, pronamespace::regnamespace::text AS ns,
         proowner::regrole::text AS owner
    INTO r
    FROM pg_proc
    WHERE pronamespace='trade_fair'::regnamespace
      AND proname='dashboard_snapshot';
  IF r IS NULL THEN RAISE EXCEPTION 'function missing after install'; END IF;
  IF r.prosecdef IS NOT TRUE THEN RAISE EXCEPTION 'function not SECURITY DEFINER'; END IF;
  IF r.provolatile <> 's' THEN RAISE EXCEPTION 'function not STABLE'; END IF;
  IF r.owner <> 'neondb_owner' THEN RAISE EXCEPTION 'function owner is %, expected neondb_owner', r.owner; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE pronamespace='trade_fair'::regnamespace
      AND proname='dashboard_snapshot'
      AND proconfig @> ARRAY['search_path=pg_catalog, trade_fair, pg_temp']
  ) THEN RAISE EXCEPTION 'function search_path is not pinned'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname='trade_fair_dashboard'
      AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication AND NOT rolinherit
  ) THEN RAISE EXCEPTION 'dashboard role attributes do not match policy'; END IF;
  IF NOT has_database_privilege('trade_fair_dashboard',current_database(),'CONNECT') THEN
    RAISE EXCEPTION 'dashboard role missing CONNECT';
  END IF;

  IF has_function_privilege('public',
       'trade_fair.dashboard_snapshot(integer,integer,text,text,text,text,text,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC still has EXECUTE on dashboard_snapshot';
  END IF;
  IF NOT has_function_privilege('trade_fair_dashboard',
       'trade_fair.dashboard_snapshot(integer,integer,text,text,text,text,text,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'trade_fair_dashboard missing EXECUTE on dashboard_snapshot';
  END IF;

  IF NOT has_schema_privilege('trade_fair_dashboard','trade_fair','USAGE') THEN
    RAISE EXCEPTION 'trade_fair_dashboard missing USAGE on trade_fair';
  END IF;
  IF has_schema_privilege('trade_fair_dashboard','trade_fair','CREATE') THEN
    RAISE EXCEPTION 'trade_fair_dashboard unexpectedly has CREATE on trade_fair';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='trade_fair' AND c.relkind IN ('r','p','v','m','f')
      AND has_table_privilege('trade_fair_dashboard', c.oid,
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  ) THEN
    RAISE EXCEPTION 'trade_fair_dashboard unexpectedly has table privileges';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='trade_fair' AND p.proname <> 'dashboard_snapshot'
      AND has_function_privilege('trade_fair_dashboard', p.oid, 'EXECUTE')
  ) THEN
    RAISE EXCEPTION 'trade_fair_dashboard unexpectedly has EXECUTE on another trade_fair function';
  END IF;
END
$post$;
COMMIT;
