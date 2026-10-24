-- OPTIONAL REVIEWED MIGRATION: DO NOT EXECUTE ON PRODUCTION WITHOUT NEON DDL/ACL REVIEW.
-- Installs the shared SECURITY DEFINER read-only function for an existing role.
\set ON_ERROR_STOP on
BEGIN;
\ir dashboard_snapshot_definition.sql
REVOKE ALL ON FUNCTION trade_fair.dashboard_snapshot(integer,integer,text,text,text,text,text,text,text) FROM PUBLIC;
GRANT USAGE ON SCHEMA trade_fair TO trade_fair_dashboard;
GRANT EXECUTE ON FUNCTION trade_fair.dashboard_snapshot(integer,integer,text,text,text,text,text,text,text) TO trade_fair_dashboard;
COMMIT;
