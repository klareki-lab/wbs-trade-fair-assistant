-- Execute as branch owner after dashboard_role_staging.sql and dashboard_snapshot.sql.
-- Fails if trade_fair_dashboard can read/write tables or execute other
-- application functions. No data rows are read.
BEGIN READ ONLY;
DO $audit$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='trade_fair_dashboard'
      AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication AND NOT rolinherit)
    OR NOT has_database_privilege('trade_fair_dashboard',current_database(),'CONNECT')
    OR NOT has_schema_privilege('trade_fair_dashboard','trade_fair','USAGE')
    OR has_schema_privilege('trade_fair_dashboard','trade_fair','CREATE')
    OR NOT has_function_privilege('trade_fair_dashboard',
      'trade_fair.dashboard_snapshot(integer,integer,text,text,text,text,text,text,text)','EXECUTE')
  THEN RAISE EXCEPTION 'Dashboard role core privileges do not match policy'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='trade_fair' AND c.relkind IN ('r','p','v','m','f')
      AND has_table_privilege('trade_fair_dashboard',c.oid,
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
  THEN RAISE EXCEPTION 'Dashboard role has direct table privilege'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='trade_fair' AND p.proname<>'dashboard_snapshot'
      AND has_function_privilege('trade_fair_dashboard',p.oid,'EXECUTE'))
  THEN RAISE EXCEPTION 'Dashboard role can execute another trade_fair function'; END IF;
END
$audit$;
ROLLBACK;
