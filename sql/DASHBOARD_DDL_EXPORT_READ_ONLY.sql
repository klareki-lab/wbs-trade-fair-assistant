-- Export structural DDL for the five Dashboard tables from pg_catalog.
-- This query does not read table rows and works without SELECT on the tables.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '10s';
WITH target AS (
  SELECT c.oid, n.nspname, c.relname,
         CASE c.relname WHEN 'companies' THEN 1 WHEN 'contacts' THEN 2
           WHEN 'lead_submissions' THEN 3 WHEN 'processing_results' THEN 4
           WHEN 'email_outbox' THEN 5 END AS seq
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'trade_fair' AND c.relkind = 'r'
    AND c.relname IN ('companies','contacts','lead_submissions','processing_results','email_outbox')
), statements AS (
  SELECT t.seq * 1000 AS ord,
         format('CREATE TABLE %I.%I (%s%s%s);', t.nspname, t.relname, E'\n',
           string_agg(format('  %I %s%s%s', a.attname,
             pg_catalog.format_type(a.atttypid,a.atttypmod),
             CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END,
             CASE WHEN d.adbin IS NOT NULL THEN ' DEFAULT ' || pg_catalog.pg_get_expr(d.adbin,d.adrelid) ELSE '' END), E',\n' ORDER BY a.attnum), E'\n') AS ddl
  FROM target t
  JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = t.oid AND d.adnum = a.attnum
  GROUP BY t.seq,t.nspname,t.relname
  UNION ALL
  SELECT t.seq * 1000 + 100 + row_number() OVER (PARTITION BY t.oid ORDER BY con.conname),
         format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s;',t.nspname,t.relname,con.conname,
                pg_catalog.pg_get_constraintdef(con.oid,true))
  FROM target t JOIN pg_catalog.pg_constraint con ON con.conrelid=t.oid
  WHERE con.contype IN ('p','u','c')
  UNION ALL
  SELECT 6000 + row_number() OVER (ORDER BY t.seq,con.conname),
         format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s;',t.nspname,t.relname,con.conname,
                pg_catalog.pg_get_constraintdef(con.oid,true))
  FROM target t JOIN pg_catalog.pg_constraint con ON con.conrelid=t.oid
  WHERE con.contype='f'
  UNION ALL
  SELECT 7000 + row_number() OVER (ORDER BY t.seq,i.relname),
         pg_catalog.pg_get_indexdef(i.oid) || ';'
  FROM target t JOIN pg_catalog.pg_index ix ON ix.indrelid=t.oid
  JOIN pg_catalog.pg_class i ON i.oid=ix.indexrelid
  WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con WHERE con.conindid=i.oid)
  UNION ALL
  SELECT 8000 + row_number() OVER (ORDER BY t.seq,tr.tgname),
         pg_catalog.pg_get_triggerdef(tr.oid,true) || ';'
  FROM target t JOIN pg_catalog.pg_trigger tr ON tr.tgrelid=t.oid
  WHERE NOT tr.tgisinternal
)
SELECT ddl FROM statements ORDER BY ord;
ROLLBACK;
