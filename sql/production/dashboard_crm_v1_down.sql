-- WBS Messe-Hub CRM V1 — reversible rollback. Drops functions and tables only;
-- never touches lead_submissions / companies / contacts / processing_results / email_outbox.
\set ON_ERROR_STOP on

\if :{?production_branch_confirmed}
  \if :production_branch_confirmed
  \else
    DO $deny$ BEGIN RAISE EXCEPTION 'Refusing CRM rollback: production_branch_confirmed is false'; END $deny$;
  \endif
\else
  DO $deny$ BEGIN RAISE EXCEPTION 'Refusing CRM rollback: pass -v production_branch_confirmed=on'; END $deny$;
\endif

BEGIN;

DO $pre$
BEGIN
  IF current_database() <> 'neondb' OR current_user <> 'neondb_owner' THEN
    RAISE EXCEPTION 'expected neondb as neondb_owner';
  END IF;
END $pre$;

REVOKE ALL ON FUNCTION trade_fair.crm_group_merge(jsonb,text,text,text)   FROM trade_fair_dashboard;
REVOKE ALL ON FUNCTION trade_fair.crm_group_split(uuid,text,text)         FROM trade_fair_dashboard;
REVOKE ALL ON FUNCTION trade_fair.crm_group_extract(uuid,text,text,text)  FROM trade_fair_dashboard;
REVOKE ALL ON FUNCTION trade_fair.crm_group_ignore(jsonb,text,text,text)  FROM trade_fair_dashboard;
REVOKE ALL ON FUNCTION trade_fair.crm_group_revert(uuid,text,text)        FROM trade_fair_dashboard;
REVOKE ALL ON FUNCTION trade_fair.crm_groups_snapshot(integer,integer,boolean) FROM trade_fair_dashboard;

DROP FUNCTION IF EXISTS trade_fair.crm_group_merge(jsonb,text,text,text);
DROP FUNCTION IF EXISTS trade_fair.crm_group_split(uuid,text,text);
DROP FUNCTION IF EXISTS trade_fair.crm_group_extract(uuid,text,text,text);
DROP FUNCTION IF EXISTS trade_fair.crm_group_ignore(jsonb,text,text,text);
DROP FUNCTION IF EXISTS trade_fair.crm_group_revert(uuid,text,text);
DROP FUNCTION IF EXISTS trade_fair.crm_groups_snapshot(integer,integer,boolean);
DROP FUNCTION IF EXISTS trade_fair._crm_validate_lead_ids(jsonb);

DROP TABLE IF EXISTS trade_fair.lead_group_audit;
DROP TABLE IF EXISTS trade_fair.lead_group_members;
DROP TABLE IF EXISTS trade_fair.lead_groups;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='trade_fair' AND c.relname IN ('lead_groups','lead_group_members','lead_group_audit')) THEN
    RAISE EXCEPTION 'CRM tables still present after rollback';
  END IF;
END $post$;

COMMIT;
