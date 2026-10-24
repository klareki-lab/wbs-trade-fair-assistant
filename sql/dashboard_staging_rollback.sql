-- Isolated Neon branch only. Never run against production.
\set ON_ERROR_STOP on
\if :{?isolated_branch_confirmed}
  \if :isolated_branch_confirmed
  \else
    DO $deny$ BEGIN RAISE EXCEPTION 'Refusing rollback: isolated branch confirmation is false'; END $deny$;
  \endif
\else
  DO $deny$ BEGIN RAISE EXCEPTION 'Refusing rollback: confirm isolated Neon branch'; END $deny$;
\endif
BEGIN;
DROP FUNCTION trade_fair.dashboard_snapshot(integer,integer,text,text,text,text,text,text,text);
REVOKE USAGE ON SCHEMA trade_fair FROM trade_fair_dashboard;
REVOKE CONNECT ON DATABASE neondb FROM trade_fair_dashboard;
DROP ROLE trade_fair_dashboard;
COMMIT;
