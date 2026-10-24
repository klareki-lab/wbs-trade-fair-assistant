CREATE TABLE trade_fair.companies (
  company_id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_name text NOT NULL,
  company_name_normalized text NOT NULL,
  website text,
  created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE trade_fair.companies ADD CONSTRAINT companies_company_name_check CHECK (char_length(company_name) >= 1 AND char_length(company_name) <= 200);
ALTER TABLE trade_fair.companies ADD CONSTRAINT companies_company_name_normalized_check CHECK (char_length(company_name_normalized) >= 1 AND char_length(company_name_normalized) <= 1000);
ALTER TABLE trade_fair.companies ADD CONSTRAINT companies_comparison_name_unique UNIQUE (company_name_normalized);
ALTER TABLE trade_fair.companies ADD CONSTRAINT companies_pkey PRIMARY KEY (company_id);
ALTER TABLE trade_fair.companies ADD CONSTRAINT companies_website_check CHECK (website IS NULL OR char_length(website) <= 2048);
CREATE TABLE trade_fair.contacts (
  contact_id uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  contact_name text,
  contact_name_normalized text,
  email text,
  email_verified boolean NOT NULL DEFAULT false,
  phone text,
  phone_normalized text,
  created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE trade_fair.contacts ADD CONSTRAINT contacts_contact_name_check CHECK (contact_name IS NULL OR char_length(contact_name) >= 1 AND char_length(contact_name) <= 160);
ALTER TABLE trade_fair.contacts ADD CONSTRAINT contacts_contact_name_normalized_check CHECK (contact_name_normalized IS NULL OR char_length(contact_name_normalized) >= 1 AND char_length(contact_name_normalized) <= 1000);
ALTER TABLE trade_fair.contacts ADD CONSTRAINT contacts_email_check CHECK (email IS NULL OR char_length(email) <= 254 AND email = lower(email));
ALTER TABLE trade_fair.contacts ADD CONSTRAINT contacts_have_details CHECK (contact_name IS NOT NULL OR email IS NOT NULL OR phone IS NOT NULL);
ALTER TABLE trade_fair.contacts ADD CONSTRAINT contacts_phone_check CHECK (phone IS NULL OR char_length(phone) <= 40);
ALTER TABLE trade_fair.contacts ADD CONSTRAINT contacts_phone_normalized_check CHECK (phone_normalized IS NULL OR char_length(phone_normalized) <= 40);
ALTER TABLE trade_fair.contacts ADD CONSTRAINT contacts_pkey PRIMARY KEY (contact_id);
ALTER TABLE trade_fair.contacts ADD CONSTRAINT verified_contact_has_email CHECK (NOT email_verified OR email IS NOT NULL);
CREATE TABLE trade_fair.lead_submissions (
  lead_id text NOT NULL,
  source text NOT NULL,
  submission_id text NOT NULL,
  company_id uuid NOT NULL,
  contact_id uuid,
  duplicate_status text NOT NULL,
  processing_status text NOT NULL DEFAULT 'pending'::text,
  processing_attempts integer NOT NULL DEFAULT 0,
  processing_started_at timestamp with time zone,
  processed_at timestamp with time zone,
  last_error_code character varying(64),
  raw_payload jsonb NOT NULL,
  normalized_payload jsonb NOT NULL,
  uncertainty_flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  possible_contact_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  review_required boolean NOT NULL DEFAULT false,
  receipt jsonb NOT NULL,
  wf_b_payload jsonb NOT NULL,
  created_at timestamp with time zone NOT NULL,
  persisted_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  processing_cycle_id uuid NOT NULL DEFAULT gen_random_uuid(),
  processing_cycle_attempts integer NOT NULL DEFAULT 0,
  processing_max_attempts integer NOT NULL DEFAULT 5,
  processing_next_retry_at timestamp with time zone DEFAULT clock_timestamp(),
  processing_lease_token uuid,
  processing_lease_expires_at timestamp with time zone,
  processing_worker_id character varying(128),
  processing_updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE trade_fair.lead_submissions ADD CONSTRAINT lead_submissions_duplicate_status_check CHECK (duplicate_status = ANY (ARRAY['NEW'::text, 'POSSIBLE_DUPLICATE'::text, 'EXISTING_CONTACT'::text]));
ALTER TABLE trade_fair.lead_submissions ADD CONSTRAINT lead_submissions_idempotency_unique UNIQUE (source, submission_id);
ALTER TABLE trade_fair.lead_submissions ADD CONSTRAINT lead_submissions_lead_id_check CHECK (lead_id ~ '^FAIR-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text);
ALTER TABLE trade_fair.lead_submissions ADD CONSTRAINT lead_submissions_normalized_payload_check CHECK (jsonb_typeof(normalized_payload) = 'object'::text);
ALTER TABLE trade_fair.lead_submissions ADD CONSTRAINT lead_submissions_pkey PRIMARY KEY (lead_id);
ALTER TABLE trade_fair.lead_submissions ADD CONSTRAINT lead_submissions_processing_attempts_check CHECK (processing_attempts >= 0);
ALTER TABLE trade_fair.lead_submissions ADD CONSTRAINT lead_submissions_processing_cycle_attempts_check CHECK (processing_cycle_attempts >= 0);
ALTER TABLE trade_fair.lead_submissions ADD CONSTRAINT lead_submissions_processing_max_attempts_check CHECK (processing_max_attempts >= 1 AND processing_max_attempts <= 20);
ALTER TABLE trade_fair.lead_submissions ADD CONSTRAINT lead_submissions_processing_status_check CHECK (processing_status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text]));
ALTER TABLE trade_fair.lead_submissions ADD CONSTRAINT lead_submissions_raw_payload_check CHECK (jsonb_typeof(raw_payload) = 'object'::text AND octet_length(raw_payload::text) <= 65536);
ALTER TABLE trade_fair.lead_submissions ADD CONSTRAINT lead_submissions_receipt_check CHECK (jsonb_typeof(receipt) = 'object'::text);
ALTER TABLE trade_fair.lead_submissions ADD CONSTRAINT lead_submissions_source_check CHECK (source = ANY (ARRAY['internal_form'::text, 'public_form'::text]));
ALTER TABLE trade_fair.lead_submissions ADD CONSTRAINT lead_submissions_submission_id_check CHECK (submission_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'::text);
ALTER TABLE trade_fair.lead_submissions ADD CONSTRAINT lead_submissions_uncertainty_flags_check CHECK (jsonb_typeof(uncertainty_flags) = 'array'::text);
ALTER TABLE trade_fair.lead_submissions ADD CONSTRAINT lead_submissions_wf_b_payload_check CHECK (jsonb_typeof(wf_b_payload) = 'object'::text);
CREATE TABLE trade_fair.processing_results (
  lead_id text NOT NULL,
  completion_token uuid NOT NULL,
  result_payload jsonb NOT NULL,
  notification_payload jsonb NOT NULL,
  score_total smallint NOT NULL,
  score_band text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE trade_fair.processing_results ADD CONSTRAINT processing_results_completion_token_key UNIQUE (completion_token);
ALTER TABLE trade_fair.processing_results ADD CONSTRAINT processing_results_notification_payload_check CHECK (jsonb_typeof(notification_payload) = 'object'::text AND octet_length(notification_payload::text) <= 262144);
ALTER TABLE trade_fair.processing_results ADD CONSTRAINT processing_results_pkey PRIMARY KEY (lead_id);
ALTER TABLE trade_fair.processing_results ADD CONSTRAINT processing_results_result_payload_check CHECK (jsonb_typeof(result_payload) = 'object'::text AND octet_length(result_payload::text) <= 262144);
ALTER TABLE trade_fair.processing_results ADD CONSTRAINT processing_results_score_band_check CHECK (score_band = ANY (ARRAY['HOT'::text, 'WARM'::text, 'COLD'::text]));
ALTER TABLE trade_fair.processing_results ADD CONSTRAINT processing_results_score_total_check CHECK (score_total >= 0 AND score_total <= 100);
CREATE TABLE trade_fair.email_outbox (
  outbox_id uuid NOT NULL DEFAULT gen_random_uuid(),
  lead_id text NOT NULL,
  idempotency_key text NOT NULL,
  sender text NOT NULL,
  recipient text NOT NULL,
  subject text NOT NULL,
  text_body text NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text,
  attempts integer NOT NULL DEFAULT 0,
  cycle_id uuid NOT NULL DEFAULT gen_random_uuid(),
  cycle_attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  next_retry_at timestamp with time zone DEFAULT clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamp with time zone,
  worker_id character varying(128),
  delivery_token uuid,
  provider_message_id text,
  delivered_at timestamp with time zone,
  last_error_code character varying(64),
  created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE trade_fair.email_outbox ADD CONSTRAINT email_outbox_attempts_check CHECK (attempts >= 0);
ALTER TABLE trade_fair.email_outbox ADD CONSTRAINT email_outbox_cycle_attempts_check CHECK (cycle_attempts >= 0);
ALTER TABLE trade_fair.email_outbox ADD CONSTRAINT email_outbox_idempotency_key_key UNIQUE (idempotency_key);
ALTER TABLE trade_fair.email_outbox ADD CONSTRAINT email_outbox_lead_id_key UNIQUE (lead_id);
ALTER TABLE trade_fair.email_outbox ADD CONSTRAINT email_outbox_max_attempts_check CHECK (max_attempts >= 1 AND max_attempts <= 20);
ALTER TABLE trade_fair.email_outbox ADD CONSTRAINT email_outbox_pkey PRIMARY KEY (outbox_id);
ALTER TABLE trade_fair.email_outbox ADD CONSTRAINT email_outbox_provider_message_id_check CHECK (provider_message_id IS NULL OR char_length(provider_message_id) <= 512);
ALTER TABLE trade_fair.email_outbox ADD CONSTRAINT email_outbox_recipient_check CHECK (char_length(recipient) >= 3 AND char_length(recipient) <= 254);
ALTER TABLE trade_fair.email_outbox ADD CONSTRAINT email_outbox_sender_check CHECK (char_length(sender) >= 3 AND char_length(sender) <= 254);
ALTER TABLE trade_fair.email_outbox ADD CONSTRAINT email_outbox_status_check CHECK (status = ANY (ARRAY['pending'::text, 'leased'::text, 'sending'::text, 'delivered'::text, 'uncertain'::text, 'failed'::text]));
ALTER TABLE trade_fair.email_outbox ADD CONSTRAINT email_outbox_subject_check CHECK (char_length(subject) >= 1 AND char_length(subject) <= 240);
ALTER TABLE trade_fair.email_outbox ADD CONSTRAINT email_outbox_text_body_check CHECK (char_length(text_body) >= 1 AND char_length(text_body) <= 60000);
ALTER TABLE trade_fair.contacts ADD CONSTRAINT contacts_company_id_fkey FOREIGN KEY (company_id) REFERENCES trade_fair.companies(company_id);
ALTER TABLE trade_fair.lead_submissions ADD CONSTRAINT lead_submissions_company_id_fkey FOREIGN KEY (company_id) REFERENCES trade_fair.companies(company_id);
ALTER TABLE trade_fair.lead_submissions ADD CONSTRAINT lead_submissions_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES trade_fair.contacts(contact_id);
ALTER TABLE trade_fair.processing_results ADD CONSTRAINT processing_results_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES trade_fair.lead_submissions(lead_id);
ALTER TABLE trade_fair.email_outbox ADD CONSTRAINT email_outbox_lead_id_fkey FOREIGN KEY (lead_id) REFERENCES trade_fair.processing_results(lead_id);
CREATE INDEX contacts_company_email_lookup ON trade_fair.contacts USING btree (company_id, email) WHERE (email IS NOT NULL);
CREATE INDEX contacts_company_name_lookup ON trade_fair.contacts USING btree (company_id, contact_name_normalized) WHERE (contact_name_normalized IS NOT NULL);
CREATE INDEX contacts_company_phone_lookup ON trade_fair.contacts USING btree (company_id, phone_normalized) WHERE (phone_normalized IS NOT NULL);
CREATE INDEX contacts_email_lookup ON trade_fair.contacts USING btree (email) WHERE (email IS NOT NULL);
CREATE UNIQUE INDEX contacts_verified_company_email_unique ON trade_fair.contacts USING btree (company_id, email) WHERE (email_verified AND (email IS NOT NULL));
CREATE INDEX lead_submissions_company_created ON trade_fair.lead_submissions USING btree (company_id, created_at DESC);
CREATE INDEX lead_submissions_contact_created ON trade_fair.lead_submissions USING btree (contact_id, created_at DESC) WHERE (contact_id IS NOT NULL);
CREATE INDEX lead_submissions_pending_queue ON trade_fair.lead_submissions USING btree (persisted_at, lead_id) WHERE (processing_status = 'pending'::text);
CREATE INDEX lead_submissions_review_queue ON trade_fair.lead_submissions USING btree (persisted_at) WHERE review_required;
CREATE INDEX processing_expired_leases ON trade_fair.lead_submissions USING btree (processing_lease_expires_at) WHERE (processing_status = 'processing'::text);
CREATE INDEX processing_ready_queue ON trade_fair.lead_submissions USING btree (processing_next_retry_at, persisted_at) WHERE (processing_status = 'pending'::text);
CREATE INDEX email_expired_leases ON trade_fair.email_outbox USING btree (lease_expires_at) WHERE (status = ANY (ARRAY['leased'::text, 'sending'::text]));
CREATE INDEX email_ready_queue ON trade_fair.email_outbox USING btree (next_retry_at, created_at) WHERE (status = 'pending'::text);
