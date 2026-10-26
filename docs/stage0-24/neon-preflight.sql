-- PREPARED ONLY. Owner-approved exact staging target; metadata only, no rows/secrets.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SELECT current_database(), current_user, session_user, version(),
       current_setting('transaction_read_only') AS read_only;
SELECT nspname, nspowner::regrole, nspacl FROM pg_namespace
 WHERE nspname IN ('trade_fair','public');
SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,
       rolinherit,rolbypassrls,rolconnlimit FROM pg_roles ORDER BY rolname;
SELECT member.rolname AS member, parent.rolname AS granted_role,m.admin_option
 FROM pg_auth_members m JOIN pg_roles member ON member.oid=m.member
 JOIN pg_roles parent ON parent.oid=m.roleid ORDER BY 1,2;
SELECT datname,datdba::regrole,datacl FROM pg_database WHERE datname=current_database();
SELECT extname,extversion,extnamespace::regnamespace FROM pg_extension ORDER BY 1;
SELECT to_regprocedure('pg_catalog.gen_random_uuid()') AS uuid_function;
SELECT c.relname,c.relkind,c.relowner::regrole,c.relacl,c.relrowsecurity,c.relforcerowsecurity
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='trade_fair' ORDER BY 1;
SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type,
 a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid) AS default_expr
 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
 JOIN pg_namespace n ON n.oid=c.relnamespace
 LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
 WHERE n.nspname='trade_fair' AND a.attnum>0 AND NOT a.attisdropped ORDER BY 1,a.attnum;
SELECT conrelid::regclass,conname,contype,convalidated,pg_get_constraintdef(oid,true)
 FROM pg_constraint WHERE connamespace='trade_fair'::regnamespace ORDER BY 1,2;
SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='trade_fair' ORDER BY 1,2;
SELECT tgrelid::regclass,tgname,pg_get_triggerdef(oid,true)
 FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN
 (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='trade_fair');
SELECT schemaname,tablename,policyname,roles,cmd,qual,with_check
 FROM pg_policies WHERE schemaname='trade_fair';
SELECT p.oid::regprocedure,p.proowner::regrole,p.prosecdef,p.provolatile,p.proconfig,p.proacl,
 md5(pg_get_functiondef(p.oid)) AS definition_fingerprint
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='trade_fair' AND p.prokind IN ('f','p') ORDER BY 1;
SELECT defaclrole::regrole,defaclnamespace::regnamespace,defaclobjtype,defaclacl
 FROM pg_default_acl ORDER BY 1,2,3;
-- Effective privileges, including inherited/PUBLIC privileges. No assumption that roles exist.
SELECT r.rolname,has_database_privilege(r.oid,current_database(),'CONNECT') AS db_connect,
 has_schema_privilege(r.oid,'trade_fair','USAGE') AS schema_usage,
 has_schema_privilege(r.oid,'trade_fair','CREATE') AS schema_create
 FROM pg_roles r WHERE r.rolname IN
 ('trade_fair_dashboard','trade_fair_ai_context','trade_fair_ai_context_staging_login');
SELECT r.rolname,c.relname,
 has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS any_access
 FROM pg_roles r CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='trade_fair' AND c.relkind IN ('r','p','v','m','f')
 AND r.rolname IN ('trade_fair_dashboard','trade_fair_ai_context','trade_fair_ai_context_staging_login') ORDER BY 1,2;
SELECT r.rolname,p.oid::regprocedure,has_function_privilege(r.oid,p.oid,'EXECUTE') AS execute
 FROM pg_roles r CROSS JOIN pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='trade_fair' AND r.rolname IN
 ('trade_fair_dashboard','trade_fair_ai_context','trade_fair_ai_context_staging_login') ORDER BY 1,2;
-- Expanded PUBLIC ACLs. grantee=0 is PUBLIC, not a login named public.
SELECT p.oid::regprocedure,x.privilege_type FROM pg_proc p
 JOIN pg_namespace n ON n.oid=p.pronamespace
 CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
 WHERE n.nspname='trade_fair' AND x.grantee=0 ORDER BY 1,2;
SELECT to_regclass('trade_fair.lead_groups') AS groups,
 to_regclass('trade_fair.lead_group_members') AS members,
 to_regclass('trade_fair.lead_group_audit') AS audit,
 EXISTS(SELECT 1 FROM pg_roles WHERE rolname='trade_fair_ai_context') AS ai_role_exists;
ROLLBACK;
