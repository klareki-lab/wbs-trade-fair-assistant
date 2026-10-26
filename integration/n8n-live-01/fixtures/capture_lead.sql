-- Synthetic isolated fixture from Yuri supplied package; NOT a production migration.
CREATE OR REPLACE FUNCTION trade_fair.capture_lead(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, trade_fair
AS $function$
DECLARE
    n jsonb := p_payload -> 'normalized';
    raw jsonb := p_payload -> 'raw_payload';
    flags jsonb;
    old_submission trade_fair.lead_submissions%ROWTYPE;
    company trade_fair.companies%ROWTYPE;
    verified_contact trade_fair.contacts%ROWTYPE;
    candidates uuid[] := ARRAY[]::uuid[];
    chosen_contact_id uuid;
    duplicate_status text := 'NEW';
    review_required boolean := false;
    website_conflict boolean := false;
    contact_name_conflict boolean := false;
    contact_email_verified boolean := false;
    incoming_website_host text;
    stored_website_host text;
    receipt jsonb;
    wf_b jsonb;
BEGIN
    -- These checks defend the adapter boundary. Detailed field-specific errors
    -- are produced by WF-A before this function is called.
    IF p_payload IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
       OR p_payload ->> 'contract_version' IS DISTINCT FROM '1.0'
       OR jsonb_typeof(n) IS DISTINCT FROM 'object'
       OR jsonb_typeof(raw) IS DISTINCT FROM 'object'
       OR octet_length(p_payload::text) > 131072 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid capture adapter envelope';
    END IF;

    IF n ->> 'source' IS NULL OR n ->> 'source' NOT IN ('internal_form', 'public_form')
       OR n ->> 'submission_id' IS NULL
       OR n ->> 'submission_id' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$'
       OR n ->> 'lead_id' IS NULL
       OR n ->> 'lead_id' !~ '^FAIR-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       OR n ->> 'created_at' IS NULL
       OR char_length(COALESCE(n ->> 'company_name', '')) NOT BETWEEN 1 AND 200
       OR char_length(COALESCE(n ->> 'company_name_normalized', '')) NOT BETWEEN 1 AND 1000
       OR char_length(COALESCE(n ->> 'contact_name', '')) > 160
       OR char_length(COALESCE(n ->> 'contact_name_normalized', '')) > 1000
       OR char_length(COALESCE(n ->> 'email', '')) > 254
       OR char_length(COALESCE(n ->> 'phone', '')) > 40
       OR char_length(COALESCE(n ->> 'website', '')) > 2048
       OR char_length(COALESCE(n ->> 'notes', '')) > 10000 THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid capture adapter fields';
    END IF;

    IF EXISTS (SELECT 1 FROM jsonb_each(n) f
               WHERE f.key <> 'uncertainty_flags'
                 AND jsonb_typeof(f.value) NOT IN ('string', 'null'))
       OR NULLIF(btrim(n ->> 'company_name'), '') IS NULL
       OR NULLIF(btrim(n ->> 'company_name_normalized'), '') IS NULL
       OR (n ->> 'contact_name' IS NOT NULL AND NULLIF(btrim(n ->> 'contact_name'), '') IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid normalized field types';
    END IF;

    IF (n ->> 'training_interest' IS NOT NULL AND n ->> 'training_interest' NOT IN (
            'leadership', 'communication', 'sales', 'project_management',
            'digital_skills', 'ai_automation', 'other'))
       OR (n ->> 'budget_status' IS NOT NULL AND n ->> 'budget_status' NOT IN (
            'approved', 'planned', 'unknown', 'not_disclosed', 'no_budget'))
       OR (n ->> 'follow_up' IS NOT NULL AND n ->> 'follow_up' NOT IN (
            'within_one_week', 'within_two_weeks', 'within_one_month',
            'on_date', 'no_follow_up', 'not_decided')) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid capture adapter enum';
    END IF;

    IF n ->> 'follow_up' = 'on_date' THEN
        IF n ->> 'follow_up_date' IS NULL
           OR n ->> 'follow_up_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
           OR (n ->> 'follow_up_date')::date < DATE '1900-01-01' THEN
            RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid follow-up date';
        END IF;
    ELSIF n ->> 'follow_up_date' IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Unexpected follow-up date';
    END IF;

    -- Exact Unicode letter/digit semantics are validated in JavaScript. SQL
    -- intentionally avoids locale-dependent character classes here so valid
    -- international names work even in databases initialized with LC_CTYPE=C.
    IF NOT (
        NULLIF(btrim(n ->> 'contact_name'), '') IS NOT NULL
        OR NULLIF(n ->> 'email', '') IS NOT NULL
        OR NULLIF(n ->> 'phone', '') IS NOT NULL
        OR char_length(btrim(COALESCE(n ->> 'notes', ''))) >= 10
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Capture requires contact details or meaningful notes';
    END IF;

    flags := COALESCE(n -> 'uncertainty_flags', '[]'::jsonb);
    IF jsonb_typeof(flags) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid uncertainty flags';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(flags) f
               WHERE jsonb_typeof(f) IS DISTINCT FROM 'string'
                  OR char_length(f #>> '{}') > 80) THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Invalid uncertainty flag value';
    END IF;

    -- Lock order is always: submission key -> company key -> email key.
    -- Transaction locks disappear on COMMIT/ROLLBACK; hash collisions only
    -- serialize otherwise unrelated requests. Unique constraints remain final guards.
    PERFORM pg_advisory_xact_lock(hashtextextended(
        'trade_fair:idempotency:' || (n ->> 'source') || ':' || (n ->> 'submission_id'), 0));

    SELECT * INTO old_submission FROM trade_fair.lead_submissions s
    WHERE s.source = n ->> 'source' AND s.submission_id = n ->> 'submission_id';

    IF FOUND THEN
        IF old_submission.raw_payload = raw THEN
            RETURN jsonb_build_object(
                'adapter', 'postgres_v1', 'http_status', 200,
                'response_body', old_submission.receipt || jsonb_build_object('idempotent_replay', true));
        END IF;
        RETURN jsonb_build_object(
            'adapter', 'postgres_v1', 'http_status', 409,
            'response_body', jsonb_build_object(
                'success', false, 'retryable', false, 'persistence_status', 'not_stored',
                'error', jsonb_build_object(
                    'code', 'IDEMPOTENCY_CONFLICT',
                    'message', 'This submission_id was already used for different content.',
                    'details', '[]'::jsonb)));
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(
        'trade_fair:company:' || (n ->> 'company_name_normalized'), 0));
    IF n ->> 'email' IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(
            'trade_fair:email:' || (n ->> 'email'), 0));
    END IF;

    INSERT INTO trade_fair.companies (company_name, company_name_normalized, website)
    VALUES (n ->> 'company_name', n ->> 'company_name_normalized', n ->> 'website')
    ON CONFLICT (company_name_normalized) DO NOTHING;

    SELECT * INTO STRICT company FROM trade_fair.companies c
    WHERE c.company_name_normalized = n ->> 'company_name_normalized';

    incoming_website_host := lower(substring(n ->> 'website' FROM '^[A-Za-z]+://([^/?#:]+)'));
    stored_website_host := lower(substring(company.website FROM '^[A-Za-z]+://([^/?#:]+)'));
    website_conflict := incoming_website_host IS NOT NULL AND stored_website_host IS NOT NULL
                        AND incoming_website_host <> stored_website_host;
    IF website_conflict THEN
        flags := flags || jsonb_build_array('company_website_conflict');
    END IF;
    IF company.website IS NULL AND n ->> 'website' IS NOT NULL THEN
        UPDATE trade_fair.companies SET website = n ->> 'website'
        WHERE company_id = company.company_id;
    END IF;

    -- Weak evidence creates review candidates, never an automatic contact merge.
    SELECT COALESCE(array_agg(q.contact_id), ARRAY[]::uuid[]) INTO candidates
    FROM (
        SELECT c.contact_id FROM trade_fair.contacts c
        WHERE (n ->> 'email' IS NOT NULL AND c.email = n ->> 'email')
           OR (c.company_id = company.company_id AND (
               (n ->> 'contact_name_normalized' IS NOT NULL
                    AND c.contact_name_normalized = n ->> 'contact_name_normalized')
               OR (n ->> 'phone_normalized' IS NOT NULL
                    AND c.phone_normalized = n ->> 'phone_normalized')))
        ORDER BY c.created_at, c.contact_id LIMIT 20
    ) q;

    SELECT * INTO verified_contact FROM trade_fair.contacts c
    WHERE c.company_id = company.company_id AND c.email_verified
          AND n ->> 'email' IS NOT NULL AND c.email = n ->> 'email';

    IF FOUND THEN
        contact_name_conflict := verified_contact.contact_name_normalized IS NOT NULL
            AND n ->> 'contact_name_normalized' IS NOT NULL
            AND verified_contact.contact_name_normalized <> n ->> 'contact_name_normalized';
        IF NOT contact_name_conflict AND NOT website_conflict THEN
            duplicate_status := 'EXISTING_CONTACT';
            chosen_contact_id := verified_contact.contact_id;
            contact_email_verified := true;
        END IF;
    END IF;

    IF duplicate_status <> 'EXISTING_CONTACT'
       AND (cardinality(candidates) > 0 OR website_conflict) THEN
        duplicate_status := 'POSSIBLE_DUPLICATE';
        review_required := true;
        IF contact_name_conflict THEN
            flags := flags || jsonb_build_array('contact_name_conflict');
        END IF;
        IF n ->> 'email' IS NOT NULL AND EXISTS (
            SELECT 1 FROM trade_fair.contacts c WHERE c.company_id = company.company_id
            AND c.email = n ->> 'email' AND NOT c.email_verified
        ) THEN flags := flags || jsonb_build_array('unverified_email_match'); END IF;
        IF n ->> 'contact_name_normalized' IS NOT NULL AND EXISTS (
            SELECT 1 FROM trade_fair.contacts c WHERE c.company_id = company.company_id
            AND c.contact_name_normalized = n ->> 'contact_name_normalized'
        ) THEN flags := flags || jsonb_build_array('same_name_at_company'); END IF;
        IF n ->> 'phone_normalized' IS NOT NULL AND EXISTS (
            SELECT 1 FROM trade_fair.contacts c WHERE c.company_id = company.company_id
            AND c.phone_normalized = n ->> 'phone_normalized'
        ) THEN flags := flags || jsonb_build_array('same_phone_at_company'); END IF;
    END IF;

    IF n ->> 'email' IS NOT NULL AND EXISTS (
        SELECT 1 FROM trade_fair.contacts c WHERE c.company_id <> company.company_id
        AND c.email = n ->> 'email'
    ) THEN
        flags := flags || jsonb_build_array('email_known_elsewhere');
        review_required := true;
    END IF;

    IF chosen_contact_id IS NULL AND (
        n ->> 'contact_name' IS NOT NULL OR n ->> 'email' IS NOT NULL OR n ->> 'phone' IS NOT NULL
    ) THEN
        INSERT INTO trade_fair.contacts (
            company_id, contact_name, contact_name_normalized, email, phone, phone_normalized
        ) VALUES (
            company.company_id, n ->> 'contact_name', n ->> 'contact_name_normalized',
            n ->> 'email', n ->> 'phone', n ->> 'phone_normalized'
        ) RETURNING contact_id INTO chosen_contact_id;
        -- email_verified stays at its false default, regardless of source.
    END IF;

    SELECT COALESCE(jsonb_agg(f.flag ORDER BY f.flag), '[]'::jsonb) INTO flags
    FROM (SELECT DISTINCT value #>> '{}' AS flag FROM jsonb_array_elements(flags)) f;

    receipt := jsonb_build_object(
        'success', true, 'persisted', true, 'lead_id', n ->> 'lead_id',
        'status', duplicate_status, 'message', 'Lead received successfully',
        'processing_status', 'pending', 'idempotent_replay', false,
        'review_required', review_required);

    wf_b := jsonb_build_object(
        'contract_version', '1.0', 'event_type', 'lead.captured',
        'lead_id', n ->> 'lead_id', 'captured_at', n ->> 'created_at',
        'submission_id', n ->> 'submission_id',
        'source', n ->> 'source',
        'company_name', n ->> 'company_name',
        'company_name_normalized', n ->> 'company_name_normalized',
        'contact_name', n ->> 'contact_name', 'email', n ->> 'email',
        'phone', n ->> 'phone', 'website', n ->> 'website',
        'training_interest', n ->> 'training_interest',
        'budget_status', n ->> 'budget_status', 'follow_up', n ->> 'follow_up',
        'follow_up_date', n ->> 'follow_up_date', 'notes', n ->> 'notes',
        'original_notes', raw -> 'notes', 'duplicate_status', duplicate_status,
        'contact_email_verified', contact_email_verified,
        'uncertainty_flags', flags, 'review_required', review_required);

    INSERT INTO trade_fair.lead_submissions (
        lead_id, source, submission_id, company_id, contact_id, duplicate_status,
        raw_payload, normalized_payload, uncertainty_flags, possible_contact_ids,
        review_required, receipt, wf_b_payload, created_at
    ) VALUES (
        n ->> 'lead_id', n ->> 'source', n ->> 'submission_id', company.company_id,
        chosen_contact_id, duplicate_status, raw,
        n || jsonb_build_object('uncertainty_flags', flags), flags, candidates,
        review_required, receipt, wf_b, (n ->> 'created_at')::timestamptz
    );

    RETURN jsonb_build_object(
        'adapter', 'postgres_v1', 'http_status', 201, 'response_body', receipt);
END;
$function$;
