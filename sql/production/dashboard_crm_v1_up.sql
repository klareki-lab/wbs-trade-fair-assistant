-- WBS Messe-Hub CRM V1 — virtual grouping, audit, SECURITY DEFINER functions.
-- Reusable with existing trade_fair_dashboard role. Reversible via dashboard_crm_v1_down.sql.
-- One transaction; owner-authorized Neon migration gate is identical to TF-07 (-v production_branch_confirmed=on).
-- Does NOT alter lead_submissions / companies / contacts / processing_results / email_outbox.

\set ON_ERROR_STOP on

\if :{?production_branch_confirmed}
  \if :production_branch_confirmed
  \else
    DO $deny$ BEGIN RAISE EXCEPTION 'Refusing CRM migration: production_branch_confirmed is false'; END $deny$;
  \endif
\else
  DO $deny$ BEGIN RAISE EXCEPTION 'Refusing CRM migration: pass -v production_branch_confirmed=on'; END $deny$;
\endif

BEGIN;

DO $pre$
BEGIN
  IF current_database() <> 'neondb' OR current_user <> 'neondb_owner' THEN
    RAISE EXCEPTION 'expected neondb as neondb_owner';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'trade_fair') THEN
    RAISE EXCEPTION 'trade_fair schema missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'trade_fair_dashboard') THEN
    RAISE EXCEPTION 'trade_fair_dashboard role missing; run dashboard_role_production.sql first';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='trade_fair' AND c.relname='lead_groups') THEN
    RAISE EXCEPTION 'trade_fair.lead_groups already exists; audit before re-run';
  END IF;
END $pre$;

-- Tables -------------------------------------------------------------------

CREATE TABLE trade_fair.lead_groups (
  group_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label       text        NOT NULL CHECK (char_length(label) BETWEEN 1 AND 160),
  status      text        NOT NULL CHECK (status IN ('active','retired','ignored')),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by  text        NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 80),
  retired_at  timestamptz NULL,
  retired_by  text        NULL CHECK (retired_by IS NULL OR char_length(retired_by) BETWEEN 1 AND 80)
);

CREATE TABLE trade_fair.lead_group_members (
  group_id    uuid NOT NULL REFERENCES trade_fair.lead_groups(group_id) ON DELETE CASCADE,
  lead_id     text NOT NULL REFERENCES trade_fair.lead_submissions(lead_id) ON DELETE RESTRICT,
  added_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  added_by    text NOT NULL CHECK (char_length(added_by) BETWEEN 1 AND 80),
  removed_at  timestamptz NULL,
  removed_by  text NULL CHECK (removed_by IS NULL OR char_length(removed_by) BETWEEN 1 AND 80),
  PRIMARY KEY (group_id, lead_id)
);
CREATE INDEX lead_group_members_lead_active ON trade_fair.lead_group_members (lead_id) WHERE removed_at IS NULL;

CREATE TABLE trade_fair.lead_group_audit (
  audit_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    uuid NULL REFERENCES trade_fair.lead_groups(group_id) ON DELETE SET NULL,
  action      text NOT NULL CHECK (action IN ('merge','split','extract','ignore','revert')),
  at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  by          text NOT NULL CHECK (char_length(by) BETWEEN 1 AND 80),
  lead_ids    jsonb NOT NULL,
  note        text NULL CHECK (note IS NULL OR char_length(note) <= 2000),
  reverted_at timestamptz NULL,
  reverted_by text NULL CHECK (reverted_by IS NULL OR char_length(reverted_by) BETWEEN 1 AND 80),
  reversal_of uuid NULL REFERENCES trade_fair.lead_group_audit(audit_id)
);
CREATE INDEX lead_group_audit_time ON trade_fair.lead_group_audit (at DESC);

-- Validation helper --------------------------------------------------------

CREATE FUNCTION trade_fair._crm_validate_lead_ids(p_ids jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY(
    SELECT jsonb_array_elements_text(p_ids)
    WHERE jsonb_typeof(p_ids) = 'array'
      AND char_length(jsonb_array_elements_text(p_ids)) BETWEEN 36 AND 41
      AND jsonb_array_elements_text(p_ids) ~ '^FAIR-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  );
$$;

-- Mutating functions (SECURITY DEFINER) ------------------------------------

CREATE FUNCTION trade_fair.crm_group_merge(p_lead_ids jsonb, p_label text, p_by text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, trade_fair, pg_temp
AS $fn$
DECLARE
  v_ids text[] := trade_fair._crm_validate_lead_ids(p_lead_ids);
  v_group uuid;
  v_audit uuid;
BEGIN
  IF v_ids IS NULL OR array_length(v_ids,1) < 2 OR array_length(v_ids,1) > 20 THEN
    RETURN jsonb_build_object('ok',false,'error_code','INVALID_LEAD_IDS');
  END IF;
  IF p_label IS NULL OR char_length(trim(p_label)) < 1 OR char_length(p_label) > 160 THEN
    RETURN jsonb_build_object('ok',false,'error_code','INVALID_LABEL');
  END IF;
  IF p_by IS NULL OR char_length(trim(p_by)) < 1 OR char_length(p_by) > 80 THEN
    RETURN jsonb_build_object('ok',false,'error_code','INVALID_ACTOR');
  END IF;
  -- All ids must exist in lead_submissions
  IF (SELECT count(*) FROM trade_fair.lead_submissions s WHERE s.lead_id = ANY(v_ids)) <> array_length(v_ids,1) THEN
    RETURN jsonb_build_object('ok',false,'error_code','UNKNOWN_LEAD');
  END IF;
  INSERT INTO trade_fair.lead_groups(label,status,created_by) VALUES (p_label,'active',p_by) RETURNING group_id INTO v_group;
  INSERT INTO trade_fair.lead_group_members(group_id,lead_id,added_by)
    SELECT v_group, x, p_by FROM unnest(v_ids) x
    ON CONFLICT (group_id,lead_id) DO NOTHING;
  INSERT INTO trade_fair.lead_group_audit(group_id,action,by,lead_ids,note) VALUES (v_group,'merge',p_by,to_jsonb(v_ids),p_note) RETURNING audit_id INTO v_audit;
  RETURN jsonb_build_object('ok',true,'group_id',v_group,'audit_id',v_audit);
END $fn$;

CREATE FUNCTION trade_fair.crm_group_split(p_group_id uuid, p_by text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, trade_fair, pg_temp
AS $fn$
DECLARE
  v_ids text[];
  v_audit uuid;
BEGIN
  IF p_by IS NULL OR char_length(trim(p_by)) < 1 THEN RETURN jsonb_build_object('ok',false,'error_code','INVALID_ACTOR'); END IF;
  IF NOT EXISTS (SELECT 1 FROM trade_fair.lead_groups WHERE group_id=p_group_id AND status='active') THEN
    RETURN jsonb_build_object('ok',false,'error_code','UNKNOWN_OR_INACTIVE_GROUP');
  END IF;
  SELECT ARRAY(SELECT lead_id FROM trade_fair.lead_group_members WHERE group_id=p_group_id AND removed_at IS NULL ORDER BY added_at) INTO v_ids;
  UPDATE trade_fair.lead_group_members SET removed_at=clock_timestamp(), removed_by=p_by WHERE group_id=p_group_id AND removed_at IS NULL;
  UPDATE trade_fair.lead_groups SET status='retired', retired_at=clock_timestamp(), retired_by=p_by WHERE group_id=p_group_id;
  INSERT INTO trade_fair.lead_group_audit(group_id,action,by,lead_ids,note) VALUES (p_group_id,'split',p_by,to_jsonb(v_ids),p_note) RETURNING audit_id INTO v_audit;
  RETURN jsonb_build_object('ok',true,'group_id',p_group_id,'audit_id',v_audit,'lead_ids',to_jsonb(v_ids));
END $fn$;

CREATE FUNCTION trade_fair.crm_group_extract(p_group_id uuid, p_lead_id text, p_by text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, trade_fair, pg_temp
AS $fn$
DECLARE
  v_new_group uuid;
  v_audit uuid;
BEGIN
  IF p_by IS NULL OR char_length(trim(p_by)) < 1 THEN RETURN jsonb_build_object('ok',false,'error_code','INVALID_ACTOR'); END IF;
  IF p_lead_id !~ '^FAIR-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RETURN jsonb_build_object('ok',false,'error_code','INVALID_LEAD_IDS');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM trade_fair.lead_group_members WHERE group_id=p_group_id AND lead_id=p_lead_id AND removed_at IS NULL) THEN
    RETURN jsonb_build_object('ok',false,'error_code','LEAD_NOT_IN_GROUP');
  END IF;
  UPDATE trade_fair.lead_group_members SET removed_at=clock_timestamp(), removed_by=p_by WHERE group_id=p_group_id AND lead_id=p_lead_id AND removed_at IS NULL;
  INSERT INTO trade_fair.lead_groups(label,status,created_by) VALUES ('Herausgelöst '||left(p_lead_id,13), 'active', p_by) RETURNING group_id INTO v_new_group;
  INSERT INTO trade_fair.lead_group_members(group_id,lead_id,added_by) VALUES (v_new_group,p_lead_id,p_by);
  INSERT INTO trade_fair.lead_group_audit(group_id,action,by,lead_ids,note) VALUES (v_new_group,'extract',p_by,jsonb_build_array(p_lead_id, jsonb_build_object('from',p_group_id)),p_note) RETURNING audit_id INTO v_audit;
  RETURN jsonb_build_object('ok',true,'group_id',v_new_group,'audit_id',v_audit);
END $fn$;

CREATE FUNCTION trade_fair.crm_group_ignore(p_lead_ids jsonb, p_label text, p_by text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, trade_fair, pg_temp
AS $fn$
DECLARE
  v_ids text[] := trade_fair._crm_validate_lead_ids(p_lead_ids);
  v_group uuid;
  v_audit uuid;
BEGIN
  IF v_ids IS NULL OR array_length(v_ids,1) < 1 OR array_length(v_ids,1) > 20 THEN
    RETURN jsonb_build_object('ok',false,'error_code','INVALID_LEAD_IDS');
  END IF;
  IF p_by IS NULL OR char_length(trim(p_by)) < 1 THEN RETURN jsonb_build_object('ok',false,'error_code','INVALID_ACTOR'); END IF;
  IF (SELECT count(*) FROM trade_fair.lead_submissions s WHERE s.lead_id = ANY(v_ids)) <> array_length(v_ids,1) THEN
    RETURN jsonb_build_object('ok',false,'error_code','UNKNOWN_LEAD');
  END IF;
  INSERT INTO trade_fair.lead_groups(label,status,created_by) VALUES (COALESCE(NULLIF(p_label,''),'Ignoriert'),'ignored',p_by) RETURNING group_id INTO v_group;
  INSERT INTO trade_fair.lead_group_members(group_id,lead_id,added_by) SELECT v_group,x,p_by FROM unnest(v_ids) x;
  INSERT INTO trade_fair.lead_group_audit(group_id,action,by,lead_ids,note) VALUES (v_group,'ignore',p_by,to_jsonb(v_ids),p_note) RETURNING audit_id INTO v_audit;
  RETURN jsonb_build_object('ok',true,'group_id',v_group,'audit_id',v_audit);
END $fn$;

CREATE FUNCTION trade_fair.crm_group_revert(p_audit_id uuid, p_by text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, trade_fair, pg_temp
AS $fn$
DECLARE
  v_src trade_fair.lead_group_audit%ROWTYPE;
  v_audit uuid;
  v_group uuid;
  v_ids text[];
BEGIN
  IF p_by IS NULL OR char_length(trim(p_by)) < 1 THEN RETURN jsonb_build_object('ok',false,'error_code','INVALID_ACTOR'); END IF;
  SELECT * INTO v_src FROM trade_fair.lead_group_audit WHERE audit_id = p_audit_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error_code','UNKNOWN_AUDIT'); END IF;
  IF v_src.reverted_at IS NOT NULL THEN RETURN jsonb_build_object('ok',false,'error_code','ALREADY_REVERTED'); END IF;
  IF v_src.action = 'revert' THEN RETURN jsonb_build_object('ok',false,'error_code','CANNOT_REVERT_REVERT'); END IF;
  IF v_src.action IN ('merge','ignore') AND v_src.group_id IS NOT NULL THEN
    -- Retire the group and mark its members removed; group remains for history.
    UPDATE trade_fair.lead_group_members SET removed_at=clock_timestamp(), removed_by=p_by WHERE group_id=v_src.group_id AND removed_at IS NULL;
    UPDATE trade_fair.lead_groups SET status='retired', retired_at=clock_timestamp(), retired_by=p_by WHERE group_id=v_src.group_id AND status<>'retired';
  ELSIF v_src.action = 'split' AND v_src.group_id IS NOT NULL THEN
    -- Re-activate retired group with its previous members.
    UPDATE trade_fair.lead_groups SET status='active', retired_at=NULL, retired_by=NULL WHERE group_id=v_src.group_id;
    SELECT ARRAY(SELECT jsonb_array_elements_text(v_src.lead_ids)) INTO v_ids;
    UPDATE trade_fair.lead_group_members SET removed_at=NULL, removed_by=NULL WHERE group_id=v_src.group_id AND lead_id = ANY(v_ids);
  ELSIF v_src.action = 'extract' AND v_src.group_id IS NOT NULL THEN
    -- Delete the single-member group created by the extract.
    UPDATE trade_fair.lead_groups SET status='retired', retired_at=clock_timestamp(), retired_by=p_by WHERE group_id=v_src.group_id AND status<>'retired';
    UPDATE trade_fair.lead_group_members SET removed_at=clock_timestamp(), removed_by=p_by WHERE group_id=v_src.group_id AND removed_at IS NULL;
  ELSE
    RETURN jsonb_build_object('ok',false,'error_code','UNSUPPORTED_REVERT');
  END IF;
  UPDATE trade_fair.lead_group_audit SET reverted_at=clock_timestamp(), reverted_by=p_by WHERE audit_id=p_audit_id;
  INSERT INTO trade_fair.lead_group_audit(group_id,action,by,lead_ids,note,reversal_of)
    VALUES (v_src.group_id,'revert',p_by,v_src.lead_ids,p_note,p_audit_id) RETURNING audit_id INTO v_audit;
  RETURN jsonb_build_object('ok',true,'audit_id',v_audit,'reversed_audit_id',p_audit_id);
END $fn$;

-- Read-only snapshot (allowlisted) ----------------------------------------

CREATE FUNCTION trade_fair.crm_groups_snapshot(p_limit integer, p_offset integer, p_include_retired boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, trade_fair, pg_temp
AS $fn$
WITH allowed AS (
  SELECT LEAST(GREATEST(COALESCE(p_limit,25),1),100) AS n,
         LEAST(GREATEST(COALESCE(p_offset,0),0),100000) AS skip,
         COALESCE(p_include_retired,false) AS inc
),
visible AS (
  SELECT g.group_id, g.label, g.status, g.created_at, g.created_by, g.retired_at
  FROM trade_fair.lead_groups g, allowed a
  WHERE (a.inc OR g.status='active' OR g.status='ignored')
),
paged AS (
  SELECT v.* FROM visible v CROSS JOIN allowed a ORDER BY v.created_at DESC LIMIT (SELECT n FROM allowed) OFFSET (SELECT skip FROM allowed)
),
members AS (
  SELECT p.group_id,
         jsonb_agg(jsonb_build_object(
           'lead_id', m.lead_id,
           'added_at', m.added_at,
           'added_by', m.added_by,
           'removed_at', m.removed_at,
           'removed_by', m.removed_by,
           'company_name', c.company_name,
           'contact_name', t.contact_name
         ) ORDER BY m.added_at) AS members
  FROM paged p
  LEFT JOIN trade_fair.lead_group_members m ON m.group_id = p.group_id
  LEFT JOIN trade_fair.lead_submissions s ON s.lead_id = m.lead_id
  LEFT JOIN trade_fair.companies c ON c.company_id = s.company_id
  LEFT JOIN trade_fair.contacts t ON t.contact_id = s.contact_id
  GROUP BY p.group_id
)
SELECT jsonb_build_object(
  'success', true,
  'total', (SELECT count(*) FROM visible),
  'groups', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'group_id', p.group_id,
      'label', p.label,
      'status', p.status,
      'created_at', p.created_at,
      'created_by', p.created_by,
      'retired_at', p.retired_at,
      'members', COALESCE(m.members, '[]'::jsonb)
    ) ORDER BY p.created_at DESC)
    FROM paged p LEFT JOIN members m ON m.group_id = p.group_id), '[]'::jsonb)
);
$fn$;

-- Privileges ---------------------------------------------------------------

ALTER FUNCTION trade_fair._crm_validate_lead_ids(jsonb)  OWNER TO neondb_owner;
ALTER FUNCTION trade_fair.crm_group_merge(jsonb,text,text,text) OWNER TO neondb_owner;
ALTER FUNCTION trade_fair.crm_group_split(uuid,text,text)       OWNER TO neondb_owner;
ALTER FUNCTION trade_fair.crm_group_extract(uuid,text,text,text) OWNER TO neondb_owner;
ALTER FUNCTION trade_fair.crm_group_ignore(jsonb,text,text,text) OWNER TO neondb_owner;
ALTER FUNCTION trade_fair.crm_group_revert(uuid,text,text)       OWNER TO neondb_owner;
ALTER FUNCTION trade_fair.crm_groups_snapshot(integer,integer,boolean) OWNER TO neondb_owner;

REVOKE ALL ON FUNCTION trade_fair._crm_validate_lead_ids(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION trade_fair.crm_group_merge(jsonb,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION trade_fair.crm_group_split(uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION trade_fair.crm_group_extract(uuid,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION trade_fair.crm_group_ignore(jsonb,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION trade_fair.crm_group_revert(uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION trade_fair.crm_groups_snapshot(integer,integer,boolean) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION trade_fair.crm_group_merge(jsonb,text,text,text)   TO trade_fair_dashboard;
GRANT EXECUTE ON FUNCTION trade_fair.crm_group_split(uuid,text,text)         TO trade_fair_dashboard;
GRANT EXECUTE ON FUNCTION trade_fair.crm_group_extract(uuid,text,text,text)  TO trade_fair_dashboard;
GRANT EXECUTE ON FUNCTION trade_fair.crm_group_ignore(jsonb,text,text,text)  TO trade_fair_dashboard;
GRANT EXECUTE ON FUNCTION trade_fair.crm_group_revert(uuid,text,text)        TO trade_fair_dashboard;
GRANT EXECUTE ON FUNCTION trade_fair.crm_groups_snapshot(integer,integer,boolean) TO trade_fair_dashboard;

-- Post-install assertions --------------------------------------------------

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='trade_fair' AND p.proname='crm_group_merge') THEN RAISE EXCEPTION 'crm_group_merge missing'; END IF;
  IF NOT has_function_privilege('trade_fair_dashboard', 'trade_fair.crm_group_merge(jsonb,text,text,text)', 'EXECUTE') THEN RAISE EXCEPTION 'dashboard EXECUTE on crm_group_merge missing'; END IF;
  IF has_function_privilege('public', 'trade_fair.crm_group_merge(jsonb,text,text,text)', 'EXECUTE') THEN RAISE EXCEPTION 'PUBLIC must not EXECUTE crm_group_merge'; END IF;
  -- All CRM functions must be SECURITY DEFINER
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='trade_fair' AND p.proname LIKE 'crm\_%' AND NOT p.prosecdef) THEN
    RAISE EXCEPTION 'all crm_* functions must be SECURITY DEFINER';
  END IF;
END $post$;

COMMIT;
