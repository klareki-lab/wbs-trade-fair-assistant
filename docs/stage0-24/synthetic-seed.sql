-- PREPARED ONLY: approved isolated staging, synthetic IDs only, never production.
\set ON_ERROR_STOP on
\if :{?isolated_stage_confirmed}
 \if :isolated_stage_confirmed
 \else
  DO $$ BEGIN RAISE EXCEPTION 'isolated_stage_confirmed is false'; END $$;
 \endif
\else
 DO $$ BEGIN RAISE EXCEPTION 'explicit isolated_stage_confirmed required'; END $$;
\endif
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='10s';
DO $$ BEGIN
 IF current_database()<>'neondb' OR current_user<>'neondb_owner' THEN
  RAISE EXCEPTION 'unexpected database/owner'; END IF;
 IF EXISTS (SELECT 1 FROM trade_fair.lead_submissions
  WHERE lead_id LIKE 'FAIR-00000000-0000-4000-8000-%') THEN
  RAISE EXCEPTION 'synthetic IDs already present: reconcile, do not overwrite'; END IF;
END $$;
INSERT INTO trade_fair.companies(company_id,company_name,company_name_normalized)
 VALUES('11111111-1111-4111-8111-111111111111','Synthetic Company','synthetic company');
INSERT INTO trade_fair.contacts(contact_id,company_id,contact_name,email)
 VALUES('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','Synthetic Person','synthetic@example.test');
INSERT INTO trade_fair.lead_submissions
 (lead_id,source,submission_id,company_id,contact_id,duplicate_status,
 raw_payload,normalized_payload,receipt,wf_b_payload,created_at)
 SELECT 'FAIR-00000000-0000-4000-8000-'||lpad(i::text,12,'0'),
 'internal_form','stage24-synthetic-'||lpad(i::text,12,'0'),
 '11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
 'POSSIBLE_DUPLICATE','{}',
 '{"notes":"PRIVATE SYNTHETIC NOTE","budget_status":"planned","training_interest":"ai_automation","follow_up":"within_one_week"}',
 '{}','{}',clock_timestamp() FROM generate_series(1,8) i;
-- No outbox records, real recipient, or worker activation. Null scores are intentional.
COMMIT;
