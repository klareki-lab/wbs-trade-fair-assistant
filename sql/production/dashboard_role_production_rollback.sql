-- WBS-TF-07 — production Neon rollback for the Dashboard dedicated role.
--
-- Separately reviewed owner operation. Runs only when
-- -v production_branch_confirmed=on. Executed as neondb_owner after the
-- Gateway is confirmed to no longer reference DASHBOARD_DATABASE_URL,
-- i.e. after the production Gateway has been recreated with
-- DASHBOARD_ENABLED=false (or removed). Running this against a Gateway
-- that still uses the function will cause live 503s on the Dashboard
-- API; the staged §9 rollback in docs/WBS_TF_06_F3B_PREP.md must come
-- first.
\set ON_ERROR_STOP on

\if :{?production_branch_confirmed}
  \if :production_branch_confirmed
  \else
    DO $deny$ BEGIN RAISE EXCEPTION 'Refusing rollback: production_branch_confirmed is false'; END $deny$;
  \endif
\else
  DO $deny$ BEGIN RAISE EXCEPTION 'Refusing rollback: pass -v production_branch_confirmed=on'; END $deny$;
\endif

BEGIN;
DROP FUNCTION IF EXISTS trade_fair.dashboard_snapshot(integer,integer,text,text,text,text,text,text,text);
REVOKE USAGE ON SCHEMA trade_fair FROM trade_fair_dashboard;
REVOKE CONNECT ON DATABASE neondb FROM trade_fair_dashboard;
DROP ROLE IF EXISTS trade_fair_dashboard;
COMMIT;

-- Post-rollback assertion.
BEGIN READ ONLY;
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='trade_fair_dashboard') THEN
    RAISE EXCEPTION 'trade_fair_dashboard still exists after rollback';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='trade_fair' AND p.proname='dashboard_snapshot') THEN
    RAISE EXCEPTION 'dashboard_snapshot still exists after rollback';
  END IF;
END
$post$;
ROLLBACK;
