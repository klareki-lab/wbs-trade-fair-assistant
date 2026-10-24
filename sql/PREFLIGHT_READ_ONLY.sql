-- WBS-TF-02: RUN FIRST, read-only against approved Neon branch/database.
-- Export/redact the report; do not include credentials or PII in tickets/PR.
BEGIN READ ONLY;
SET LOCAL statement_timeout='5s';
SELECT current_database() AS database, current_user AS database_role,
       current_setting('server_version') AS pg_version;
SELECT table_name,column_name,data_type,is_nullable
FROM information_schema.columns
WHERE table_schema='trade_fair'
 AND table_name IN ('companies','contacts','lead_submissions','processing_results','email_outbox')
ORDER BY table_name,ordinal_position;
SELECT table_name FROM information_schema.tables
WHERE table_schema='trade_fair'
 AND table_name IN ('companies','contacts','lead_submissions','processing_results','email_outbox')
ORDER BY table_name;
SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS signature,
       p.prosecdef AS security_definer
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='trade_fair' AND p.proname='dashboard_snapshot';
SELECT rolname,rolcanlogin,rolsuper,rolinherit FROM pg_roles WHERE rolname='trade_fair_app';
SELECT has_schema_privilege('trade_fair_app','trade_fair','USAGE') AS app_schema_usage;
ROLLBACK;
