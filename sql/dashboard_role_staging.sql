-- Run only after confirming the connection targets an isolated Neon branch.
-- Supply -v isolated_branch_confirmed=on and set the password only in the
-- process environment WBS_DASHBOARD_STAGING_ROLE_PASSWORD.
\set ON_ERROR_STOP on
\if :{?isolated_branch_confirmed}
  \if :isolated_branch_confirmed
  \else
    DO $deny$ BEGIN RAISE EXCEPTION 'Refusing role creation: isolated branch confirmation is false'; END $deny$;
  \endif
\else
  DO $deny$ BEGIN RAISE EXCEPTION 'Refusing role creation: confirm isolated Neon branch'; END $deny$;
\endif
\getenv dashboard_password WBS_DASHBOARD_STAGING_ROLE_PASSWORD
\if :{?dashboard_password}
\else
  DO $deny$ BEGIN RAISE EXCEPTION 'Refusing role creation: set WBS_DASHBOARD_STAGING_ROLE_PASSWORD'; END $deny$;
\endif
BEGIN;
CREATE ROLE trade_fair_dashboard LOGIN PASSWORD :'dashboard_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
GRANT CONNECT ON DATABASE neondb TO trade_fair_dashboard;
COMMIT;
