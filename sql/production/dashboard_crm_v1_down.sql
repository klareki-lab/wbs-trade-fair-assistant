-- R2 SAFE APPLICATION ROLLBACK: deliberately no DROP, DELETE or grant changes.
-- Run the previous application image / disable CRM UI via MESSE_CRM_ENABLED=false.
-- Keep schema, groups and audit for forward repair and investigation.
-- See docs/WBS_MESSE_HUB_FULL_INTEGRATION.md. Destructive purge is a separate
-- Owner-authorized operation requiring verified archive and restore rehearsal.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
SELECT 'CRM data retained; roll back application image, not CRM schema' AS rollback_policy;
COMMIT;
