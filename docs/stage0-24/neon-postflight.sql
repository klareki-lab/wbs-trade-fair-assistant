-- PREPARED ONLY. Owner login, approved isolated staging. SELECT only.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL statement_timeout='10s';
-- Each violation query must return zero rows. Run neon-preflight.sql again too.
SELECT lead_id,count(*) FROM trade_fair.lead_group_members
 WHERE removed_at IS NULL GROUP BY lead_id HAVING count(*)>1;
SELECT m.group_id,m.lead_id FROM trade_fair.lead_group_members m
 JOIN trade_fair.lead_groups g USING(group_id)
 WHERE m.removed_at IS NULL AND g.status='retired';
SELECT a.audit_id FROM trade_fair.lead_group_audit a
 LEFT JOIN trade_fair.lead_group_audit b ON b.audit_id=a.reversal_of
 WHERE a.action='revert' AND (b.audit_id IS NULL OR b.reverted_at IS NULL);
SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='trade_fair' AND
 (p.proname LIKE 'crm_%' OR p.proname LIKE '_crm_%' OR p.proname='ai_lead_context')
 AND (p.proowner<>'neondb_owner'::regrole OR
 NOT coalesce(p.proconfig @> ARRAY['search_path=pg_catalog, trade_fair, pg_temp'],false));
SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x
 WHERE n.nspname='trade_fair' AND
 (p.proname LIKE 'crm_%' OR p.proname LIKE '_crm_%' OR p.proname='ai_lead_context')
 AND x.grantee=0 AND x.privilege_type='EXECUTE';
-- Inventory: unique partial index must be UNIQUE, WHERE removed_at IS NULL.
SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='trade_fair'
 AND indexname='lead_group_members_one_current';
SELECT trade_fair.crm_groups_snapshot(1,0,true,0)->>'success' AS snapshot_ok;
ROLLBACK;
