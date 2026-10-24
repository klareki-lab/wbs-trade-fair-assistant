-- Catalog-only inventory: works even when information_schema hides table columns.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
SELECT current_database() AS database, current_user AS database_role,
       current_setting('server_version') AS pg_version;
SELECT c.relname AS table_name, a.attnum AS ordinal, a.attname AS column_name,
       pg_catalog.format_type(a.atttypid, a.atttypmod) AS column_type,
       a.attnotnull AS not_null,
       pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expr,
       a.attidentity AS identity_kind, a.attgenerated AS generated_kind
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
WHERE n.nspname = 'trade_fair' AND c.relkind IN ('r','p')
  AND c.relname IN ('companies','contacts','lead_submissions','processing_results','email_outbox')
  AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY c.relname, a.attnum;
SELECT c.relname AS table_name, con.conname AS constraint_name,
       pg_catalog.pg_get_constraintdef(con.oid, true) AS definition
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'trade_fair'
  AND c.relname IN ('companies','contacts','lead_submissions','processing_results','email_outbox')
ORDER BY c.relname, con.conname;
SELECT tablename, indexname, indexdef FROM pg_catalog.pg_indexes
WHERE schemaname = 'trade_fair'
  AND tablename IN ('companies','contacts','lead_submissions','processing_results','email_outbox')
ORDER BY tablename, indexname;
SELECT c.relname AS table_name, t.tgname AS trigger_name,
       pg_catalog.pg_get_triggerdef(t.oid, true) AS definition
FROM pg_catalog.pg_trigger t
JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'trade_fair'
  AND c.relname IN ('companies','contacts','lead_submissions','processing_results','email_outbox')
  AND NOT t.tgisinternal
ORDER BY c.relname, t.tgname;
ROLLBACK;
