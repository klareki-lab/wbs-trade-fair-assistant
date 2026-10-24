CREATE SCHEMA trade_fair;
CREATE TABLE trade_fair.companies (
  company_id uuid PRIMARY KEY, company_name text NOT NULL, website text
);
CREATE TABLE trade_fair.contacts (
  contact_id uuid PRIMARY KEY, contact_name text, email text, phone text,
  email_verified boolean NOT NULL DEFAULT false
);
CREATE TABLE trade_fair.lead_submissions (
  lead_id text PRIMARY KEY, company_id uuid NOT NULL REFERENCES trade_fair.companies,
  contact_id uuid REFERENCES trade_fair.contacts, source text NOT NULL,
  created_at timestamptz NOT NULL, processing_status text NOT NULL,
  processing_attempts integer NOT NULL, last_error_code varchar(64),
  duplicate_status text NOT NULL, review_required boolean NOT NULL,
  uncertainty_flags jsonb NOT NULL, possible_contact_ids uuid[] NOT NULL,
  normalized_payload jsonb NOT NULL
);
CREATE TABLE trade_fair.processing_results (
  lead_id text PRIMARY KEY REFERENCES trade_fair.lead_submissions,
  score_band text NOT NULL, score_total smallint NOT NULL,
  result_payload jsonb NOT NULL, created_at timestamptz NOT NULL
);
CREATE TABLE trade_fair.email_outbox (
  lead_id text UNIQUE NOT NULL REFERENCES trade_fair.processing_results,
  status text NOT NULL, last_error_code varchar(64), updated_at timestamptz NOT NULL
);
INSERT INTO trade_fair.companies VALUES
  ('11111111-1111-4111-8111-111111111111','Synthetic Company','https://example.test');
INSERT INTO trade_fair.contacts VALUES
  ('22222222-2222-4222-8222-222222222222','Synthetic Person','synthetic@example.test',NULL,true);
INSERT INTO trade_fair.lead_submissions VALUES
  ('FAIR-33333333-3333-4333-8333-333333333333',
   '11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222',
   'internal_form','2026-10-24T09:00:00Z','completed',1,NULL,'NEW',false,
   '[]','{}','{"training_interest":"Synthetic course"}');
INSERT INTO trade_fair.processing_results VALUES
  ('FAIR-33333333-3333-4333-8333-333333333333','WARM',45,'{}','2026-10-24T09:01:00Z');
INSERT INTO trade_fair.email_outbox VALUES
  ('FAIR-33333333-3333-4333-8333-333333333333','delivered',NULL,'2026-10-24T09:02:00Z');
