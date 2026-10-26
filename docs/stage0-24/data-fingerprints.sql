-- Owner-approved synthetic staging/restore only. Reads all trade_fair rows.
-- Fingerprints are comparison aids, not cryptographic backup signatures.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL statement_timeout='30s';
SELECT format(
 'SELECT %L AS table_name, count(*) AS row_count, md5(coalesce(string_agg(md5(to_jsonb(t)::text), %L ORDER BY md5(to_jsonb(t)::text)), %L)) AS fingerprint FROM %I.%I t;',
 c.relname,'','',n.nspname,c.relname)
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='trade_fair' AND c.relkind IN ('r','p') AND NOT c.relispartition
 ORDER BY c.relname
\gexec
ROLLBACK;
