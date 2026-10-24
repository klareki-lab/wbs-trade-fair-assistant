-- WBS-TF-07 — production Neon migration for the Dashboard dedicated role.
--
-- Separately reviewed owner migration. NOT the staging-only
-- sql/dashboard_role_staging.sql. Guarded against accidental staging
-- execution by refusing to run unless -v production_branch_confirmed=on.
--
-- Executed as neondb_owner on the production Neon branch. Password is
-- read from the process environment variable WBS_DASHBOARD_PROD_ROLE_PASSWORD
-- and never echoed to stdout. Function install, revocations and grant
-- happen in a single transaction and are atomic.
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

-- Early sanity checks: schema must exist and be owned by neondb_owner,
-- and the role must not already exist (replays after rollback are a
-- separate operation).
DO $pre$
BEGIN
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

BEGIN;

CREATE ROLE trade_fair_dashboard LOGIN PASSWORD :'dashboard_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;

GRANT CONNECT ON DATABASE neondb TO trade_fair_dashboard;

-- The function body is identical to sql/dashboard_snapshot.sql; this
-- migration keeps the role and the function in the same transaction so
-- partial state is impossible.
\i sql/dashboard_snapshot.sql

-- dashboard_snapshot.sql opens and commits its own BEGIN block. If this
-- fails on a particular psql version, replace the \i with an inline copy
-- of the function body wrapped in CREATE FUNCTION ... REVOKE ... GRANT.
-- No change in semantics either way.

COMMIT;

-- Post-install assertions (own transaction, read-only).
BEGIN READ ONLY;
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
ROLLBACK;
