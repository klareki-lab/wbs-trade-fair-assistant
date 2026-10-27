-- WBS Messe-Hub CRM V1 — virtual grouping, audit, SECURITY DEFINER functions.
-- Application rollback preserves tables and audit. Fresh install only; no live migration performed.
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
  IF has_schema_privilege('trade_fair_dashboard','trade_fair','CREATE') THEN RAISE EXCEPTION 'dashboard must not CREATE in trade_fair'; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='trade_fair_ai_context') THEN RAISE EXCEPTION 'AI role already exists; audit before install'; END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='trade_fair' AND c.relname='lead_groups') THEN
    RAISE EXCEPTION 'trade_fair.lead_groups already exists; audit before re-run';
  END IF;
END $pre$;

-- R2: fresh install only. Application rollback retains these tables and audit.
CREATE TABLE trade_fair.lead_groups (
  group_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 160),
  status text NOT NULL CHECK (status IN ('active','retired','ignored')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by text NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 80),
  retired_at timestamptz, retired_by text
);
CREATE TABLE trade_fair.lead_group_members (
  group_id uuid NOT NULL REFERENCES trade_fair.lead_groups ON DELETE RESTRICT,
  lead_id text NOT NULL REFERENCES trade_fair.lead_submissions(lead_id) ON DELETE RESTRICT,
  added_at timestamptz NOT NULL DEFAULT clock_timestamp(), added_by text NOT NULL,
  removed_at timestamptz, removed_by text,
  PRIMARY KEY (group_id,lead_id)
);
-- Ignored groups reserve membership too; merge/ignore of a grouped lead is a conflict.
CREATE UNIQUE INDEX lead_group_members_one_current ON trade_fair.lead_group_members(lead_id) WHERE removed_at IS NULL;
CREATE TABLE trade_fair.lead_group_audit (
  audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_no bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  group_id uuid NOT NULL REFERENCES trade_fair.lead_groups ON DELETE RESTRICT,
  group_ids uuid[] NOT NULL,
  action text NOT NULL CHECK (action IN ('merge','split','extract','ignore','revert')),
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  by text NOT NULL CHECK (char_length(by) BETWEEN 1 AND 80),
  lead_ids jsonb NOT NULL CHECK (jsonb_typeof(lead_ids)='array'),
  before_state jsonb NOT NULL DEFAULT '[]',
  note text CHECK (note IS NULL OR char_length(note)<=2000),
  reverted_at timestamptz, reverted_by text,
  reversal_of uuid UNIQUE REFERENCES trade_fair.lead_group_audit(audit_id)
);
CREATE INDEX lead_group_audit_time ON trade_fair.lead_group_audit(event_no DESC);
CREATE INDEX lead_group_audit_leads ON trade_fair.lead_group_audit USING gin(lead_ids);
CREATE INDEX lead_group_audit_groups ON trade_fair.lead_group_audit USING gin(group_ids);

-- Return NULL for any invalid input. Never filter a malformed request into a valid one.
CREATE FUNCTION trade_fair._crm_validate_lead_ids(p_ids jsonb) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,trade_fair,pg_temp AS $$
DECLARE ids text[];
BEGIN
  IF p_ids IS NULL OR jsonb_typeof(p_ids)<>'array' THEN RETURN NULL; END IF;
  IF jsonb_array_length(p_ids) NOT BETWEEN 1 AND 20 THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_ids) x(v)
    WHERE jsonb_typeof(v)<>'string' OR (v#>>'{}') !~ '^FAIR-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') THEN RETURN NULL; END IF;
  SELECT array_agg(v ORDER BY v) INTO ids FROM jsonb_array_elements_text(p_ids) x(v);
  IF cardinality(ids)<>(SELECT count(DISTINCT v) FROM unnest(ids) x(v)) THEN RETURN NULL; END IF;
  RETURN ids;
END $$;

CREATE FUNCTION trade_fair._crm_can_revert(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,trade_fair,pg_temp AS $$
  SELECT COALESCE((SELECT a.action<>'revert' AND a.reverted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM trade_fair.lead_group_audit n WHERE n.event_no>a.event_no
      AND (n.group_ids && a.group_ids OR n.lead_ids ?| ARRAY(SELECT jsonb_array_elements_text(a.lead_ids))))
    FROM trade_fair.lead_group_audit a WHERE a.audit_id=p_id),false);
$$;

-- All entrypoints take the same transaction lock BEFORE reading CRM state. At CRM
-- scale this is deliberate serialization, including different API routes and sessions.
-- Lead rows are then locked in lexical order. The unique index is the final invariant.
CREATE FUNCTION trade_fair._crm_change(p_action text,p_ids jsonb,p_group uuid,p_lead text,p_label text,p_by text,p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,trade_fair,pg_temp AS $$
DECLARE ids text[]; touched text[]; g uuid; a uuid; before jsonb:='[]'; groups uuid[]; current_status text;
BEGIN
  IF p_by IS NULL OR (char_length(btrim(p_by))<1 OR char_length(p_by)>80) OR (p_note IS NOT NULL AND char_length(p_note)>2000) THEN
    RETURN jsonb_build_object('ok',false,'error_code','INVALID_ACTOR_OR_NOTE'); END IF;
  IF p_action NOT IN ('merge','ignore','split','extract') OR p_action IS NULL THEN RETURN jsonb_build_object('ok',false,'error_code','INVALID_ACTION'); END IF;
  PERFORM pg_advisory_xact_lock(20822,1);
  IF p_action IN ('merge','ignore') THEN
    ids:=trade_fair._crm_validate_lead_ids(p_ids);
    IF ids IS NULL OR (p_action='merge' AND cardinality(ids)<2) THEN RETURN jsonb_build_object('ok',false,'error_code','INVALID_LEAD_IDS'); END IF;
    IF p_label IS NULL OR char_length(btrim(p_label)) NOT BETWEEN 1 AND 160 THEN RETURN jsonb_build_object('ok',false,'error_code','INVALID_LABEL'); END IF;
    PERFORM s.lead_id FROM trade_fair.lead_submissions s WHERE s.lead_id=ANY(ids) ORDER BY s.lead_id FOR UPDATE;
    IF (SELECT count(*) FROM trade_fair.lead_submissions WHERE lead_id=ANY(ids))<>cardinality(ids) THEN RETURN jsonb_build_object('ok',false,'error_code','UNKNOWN_LEAD'); END IF;
    IF EXISTS (SELECT 1 FROM trade_fair.lead_group_members WHERE lead_id=ANY(ids) AND removed_at IS NULL) THEN RETURN jsonb_build_object('ok',false,'error_code','MEMBERSHIP_CONFLICT'); END IF;
    INSERT INTO trade_fair.lead_groups(label,status,created_by) VALUES(btrim(p_label),CASE WHEN p_action='ignore' THEN 'ignored' ELSE 'active' END,p_by) RETURNING group_id INTO g;
    INSERT INTO trade_fair.lead_group_members(group_id,lead_id,added_by) SELECT g,x,p_by FROM unnest(ids) x;
    touched:=ids; groups:=ARRAY[g];
  ELSE
    SELECT status INTO current_status FROM trade_fair.lead_groups WHERE group_id=p_group FOR UPDATE;
    IF current_status IS DISTINCT FROM 'active' THEN RETURN jsonb_build_object('ok',false,'error_code','UNKNOWN_OR_INACTIVE_GROUP'); END IF;
    SELECT array_agg(lead_id ORDER BY lead_id) INTO ids FROM trade_fair.lead_group_members WHERE group_id=p_group AND removed_at IS NULL;
    IF ids IS NULL THEN RETURN jsonb_build_object('ok',false,'error_code','EMPTY_GROUP'); END IF;
    PERFORM s.lead_id FROM trade_fair.lead_submissions s WHERE s.lead_id=ANY(ids) ORDER BY s.lead_id FOR UPDATE;
    SELECT jsonb_build_array(jsonb_build_object('group',to_jsonb(gr),'members',
      (SELECT jsonb_agg(to_jsonb(m) ORDER BY m.lead_id) FROM trade_fair.lead_group_members m WHERE m.group_id=p_group)))
      INTO before FROM trade_fair.lead_groups gr WHERE gr.group_id=p_group;
    touched:=ids; groups:=ARRAY[p_group]; g:=p_group;
    IF p_action='split' THEN
      UPDATE trade_fair.lead_group_members SET removed_at=clock_timestamp(),removed_by=p_by WHERE group_id=p_group AND removed_at IS NULL;
      UPDATE trade_fair.lead_groups SET status='retired',retired_at=clock_timestamp(),retired_by=p_by WHERE group_id=p_group;
    ELSE
      IF p_lead IS NULL OR NOT (p_lead=ANY(ids)) THEN RETURN jsonb_build_object('ok',false,'error_code','LEAD_NOT_IN_GROUP'); END IF;
      UPDATE trade_fair.lead_group_members SET removed_at=clock_timestamp(),removed_by=p_by WHERE group_id=p_group AND lead_id=p_lead;
      -- Retire an empty source group; reverting restores its prior status exactly.
      IF cardinality(ids)=1 THEN UPDATE trade_fair.lead_groups SET status='retired',retired_at=clock_timestamp(),retired_by=p_by WHERE group_id=p_group; END IF;
      INSERT INTO trade_fair.lead_groups(label,status,created_by) VALUES('Herausgelöst '||left(p_lead,13),'active',p_by) RETURNING group_id INTO g;
      INSERT INTO trade_fair.lead_group_members(group_id,lead_id,added_by) VALUES(g,p_lead,p_by);
      groups:=groups||g;
    END IF;
  END IF;
  INSERT INTO trade_fair.lead_group_audit(group_id,group_ids,action,by,lead_ids,before_state,note)
    VALUES(g,groups,p_action,p_by,to_jsonb(touched),before,p_note) RETURNING audit_id INTO a;
  RETURN jsonb_build_object('ok',true,'group_id',g,'audit_id',a);
END $$;

CREATE FUNCTION trade_fair.crm_group_merge(p_lead_ids jsonb,p_label text,p_by text,p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,trade_fair,pg_temp AS $$
 SELECT trade_fair._crm_change('merge',p_lead_ids,NULL,NULL,p_label,p_by,p_note);
$$;

CREATE FUNCTION trade_fair.crm_group_ignore(p_lead_ids jsonb,p_label text,p_by text,p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,trade_fair,pg_temp AS $$
 SELECT trade_fair._crm_change('ignore',p_lead_ids,NULL,NULL,p_label,p_by,p_note);
$$;

CREATE FUNCTION trade_fair.crm_group_split(p_group_id uuid,p_by text,p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,trade_fair,pg_temp AS $$
 SELECT trade_fair._crm_change('split',NULL,p_group_id,NULL,NULL,p_by,p_note);
$$;

CREATE FUNCTION trade_fair.crm_group_extract(p_group_id uuid,p_lead_id text,p_by text,p_note text DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,trade_fair,pg_temp AS $$
 SELECT trade_fair._crm_change('extract',NULL,p_group_id,p_lead_id,NULL,p_by,p_note);
$$;

CREATE FUNCTION trade_fair.crm_group_revert(p_audit_id uuid,p_by text,p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,trade_fair,pg_temp AS $$
DECLARE src trade_fair.lead_group_audit%ROWTYPE; a uuid; state jsonb; m jsonb; gid uuid;
BEGIN
  IF p_by IS NULL OR (char_length(btrim(p_by))<1 OR char_length(p_by)>80) OR (p_note IS NOT NULL AND char_length(p_note)>2000) THEN
    RETURN jsonb_build_object('ok',false,'error_code','INVALID_ACTOR_OR_NOTE'); END IF;
  PERFORM pg_advisory_xact_lock(20822,1);
  SELECT * INTO src FROM trade_fair.lead_group_audit WHERE audit_id=p_audit_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error_code','UNKNOWN_AUDIT'); END IF;
  IF src.reverted_at IS NOT NULL THEN RETURN jsonb_build_object('ok',false,'error_code','ALREADY_REVERTED'); END IF;
  IF src.action='revert' THEN RETURN jsonb_build_object('ok',false,'error_code','CANNOT_REVERT_REVERT'); END IF;
  IF NOT trade_fair._crm_can_revert(p_audit_id) THEN RETURN jsonb_build_object('ok',false,'error_code','STALE_REVERT'); END IF;
  PERFORM s.lead_id FROM trade_fair.lead_submissions s WHERE src.lead_ids ? s.lead_id ORDER BY s.lead_id FOR UPDATE;
  -- Remove created membership first so restoration respects the unique index.
  IF src.action IN ('merge','ignore','extract') THEN
    UPDATE trade_fair.lead_group_members SET removed_at=clock_timestamp(),removed_by=p_by WHERE group_id=src.group_id AND removed_at IS NULL;
    UPDATE trade_fair.lead_groups SET status='retired',retired_at=clock_timestamp(),retired_by=p_by WHERE group_id=src.group_id;
  END IF;
  FOR state IN SELECT value FROM jsonb_array_elements(src.before_state) LOOP
    gid:=(state->'group'->>'group_id')::uuid;
    UPDATE trade_fair.lead_groups SET status=state->'group'->>'status',retired_at=(state->'group'->>'retired_at')::timestamptz,retired_by=state->'group'->>'retired_by' WHERE group_id=gid;
    FOR m IN SELECT value FROM jsonb_array_elements(state->'members') LOOP
      UPDATE trade_fair.lead_group_members SET removed_at=(m->>'removed_at')::timestamptz,removed_by=m->>'removed_by' WHERE group_id=gid AND lead_id=m->>'lead_id';
    END LOOP;
  END LOOP;
  UPDATE trade_fair.lead_group_audit SET reverted_at=clock_timestamp(),reverted_by=p_by WHERE audit_id=p_audit_id;
  INSERT INTO trade_fair.lead_group_audit(group_id,group_ids,action,by,lead_ids,note,reversal_of)
    VALUES(src.group_id,src.group_ids,'revert',p_by,src.lead_ids,p_note,p_audit_id) RETURNING audit_id INTO a;
  RETURN jsonb_build_object('ok',true,'audit_id',a,'reversed_audit_id',p_audit_id);
END $$;

CREATE FUNCTION trade_fair.crm_groups_snapshot(p_limit integer,p_offset integer,p_include_retired boolean DEFAULT false,p_audit_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,trade_fair,pg_temp AS $$
WITH visible AS (SELECT * FROM trade_fair.lead_groups WHERE COALESCE(p_include_retired,false) OR status<>'retired'),
paged AS (SELECT * FROM visible ORDER BY created_at DESC,group_id LIMIT LEAST(GREATEST(COALESCE(p_limit,25),1),100) OFFSET LEAST(GREATEST(COALESCE(p_offset,0),0),1000000)),
audit_page AS (SELECT * FROM trade_fair.lead_group_audit ORDER BY event_no DESC LIMIT LEAST(GREATEST(COALESCE(p_limit,25),1),100) OFFSET LEAST(GREATEST(COALESCE(p_audit_offset,0),0),1000000))
SELECT jsonb_build_object('success',true,'total',(SELECT count(*) FROM visible),
 'groups',COALESCE((SELECT jsonb_agg(jsonb_build_object('group_id',g.group_id,'label',g.label,'status',g.status,'created_at',g.created_at,'created_by',g.created_by,'retired_at',g.retired_at,
   'members',COALESCE((SELECT jsonb_agg(jsonb_build_object('lead_id',m.lead_id,'added_at',m.added_at,'added_by',m.added_by,'removed_at',m.removed_at,'removed_by',m.removed_by,'company_name',c.company_name,'contact_name',t.contact_name) ORDER BY m.lead_id)
    FROM trade_fair.lead_group_members m JOIN trade_fair.lead_submissions s ON s.lead_id=m.lead_id LEFT JOIN trade_fair.companies c ON c.company_id=s.company_id LEFT JOIN trade_fair.contacts t ON t.contact_id=s.contact_id WHERE m.group_id=g.group_id),'[]'::jsonb)) ORDER BY g.created_at DESC,g.group_id) FROM paged g),'[]'::jsonb),
 'audit_total',(SELECT count(*) FROM trade_fair.lead_group_audit),
 'audit',COALESCE((SELECT jsonb_agg(jsonb_build_object('audit_id',a.audit_id,'group_id',a.group_id,'action',a.action,'at',a.at,'by',a.by,'lead_ids',a.lead_ids,'note',a.note,'reverted_at',a.reverted_at,'reversal_of',a.reversal_of,'can_revert',trade_fair._crm_can_revert(a.audit_id)) ORDER BY a.event_no DESC) FROM audit_page a),'[]'::jsonb));
$$;

-- Dedicated bounded WF-08 context: no contact/company names, email, phone, notes,
-- free text, raw payloads or other page rows. Separate narrowly scoped role.
CREATE ROLE trade_fair_ai_context NOLOGIN;
GRANT USAGE ON SCHEMA trade_fair TO trade_fair_ai_context;
CREATE FUNCTION trade_fair.ai_lead_context(p_ids jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,trade_fair,pg_temp AS $$
DECLARE ids text[]; result jsonb;
BEGIN
 ids:=trade_fair._crm_validate_lead_ids(p_ids);
 IF ids IS NULL THEN RAISE EXCEPTION 'INVALID_CONTEXT' USING ERRCODE='22023'; END IF;
 IF (SELECT count(*) FROM trade_fair.lead_submissions WHERE lead_id=ANY(ids))<>cardinality(ids) THEN RAISE EXCEPTION 'UNKNOWN_CONTEXT' USING ERRCODE='22023'; END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('lead_id',s.lead_id,
  'score_band',CASE WHEN r.score_band IN ('HOT','WARM','COLD') THEN r.score_band END,
  'score_total',CASE WHEN r.score_total BETWEEN 0 AND 100 THEN r.score_total END,
  'processing_status',CASE WHEN s.processing_status IN ('pending','processing','completed','failed') THEN s.processing_status END,
  'email_status',CASE WHEN e.status IN ('pending','leased','sending','delivered','uncertain','failed') THEN e.status END,
  'duplicate_status',CASE WHEN s.duplicate_status IN ('NEW','POSSIBLE_DUPLICATE','EXISTING_CONTACT') THEN s.duplicate_status END,
  'training_interest',CASE WHEN s.normalized_payload->>'training_interest' IN ('leadership','communication','sales','project_management','digital_skills','ai_automation','other') THEN s.normalized_payload->>'training_interest' END,
  'budget_status',CASE WHEN s.normalized_payload->>'budget_status' IN ('approved','planned','unknown','not_disclosed','no_budget') THEN s.normalized_payload->>'budget_status' END,
  'follow_up',CASE WHEN s.normalized_payload->>'follow_up' IN ('within_one_week','within_two_weeks','within_one_month','on_date','no_follow_up','not_decided') THEN s.normalized_payload->>'follow_up' END)
  ORDER BY s.lead_id),'[]'::jsonb) INTO result FROM trade_fair.lead_submissions s
 LEFT JOIN trade_fair.processing_results r ON r.lead_id=s.lead_id
 LEFT JOIN trade_fair.email_outbox e ON e.lead_id=s.lead_id WHERE s.lead_id=ANY(ids);
 RETURN jsonb_build_object('success',true,'context',result);
END $$;

REVOKE ALL ON trade_fair.lead_groups,trade_fair.lead_group_members,trade_fair.lead_group_audit FROM PUBLIC,trade_fair_dashboard,trade_fair_ai_context;
ALTER FUNCTION trade_fair._crm_validate_lead_ids(jsonb) OWNER TO neondb_owner;
REVOKE ALL ON FUNCTION trade_fair._crm_validate_lead_ids(jsonb) FROM PUBLIC,trade_fair_dashboard,trade_fair_ai_context;
ALTER FUNCTION trade_fair._crm_can_revert(uuid) OWNER TO neondb_owner;
REVOKE ALL ON FUNCTION trade_fair._crm_can_revert(uuid) FROM PUBLIC,trade_fair_dashboard,trade_fair_ai_context;
ALTER FUNCTION trade_fair._crm_change(text,jsonb,uuid,text,text,text,text) OWNER TO neondb_owner;
REVOKE ALL ON FUNCTION trade_fair._crm_change(text,jsonb,uuid,text,text,text,text) FROM PUBLIC,trade_fair_dashboard,trade_fair_ai_context;
ALTER FUNCTION trade_fair.crm_group_merge(jsonb,text,text,text) OWNER TO neondb_owner;
REVOKE ALL ON FUNCTION trade_fair.crm_group_merge(jsonb,text,text,text) FROM PUBLIC,trade_fair_dashboard,trade_fair_ai_context;
GRANT EXECUTE ON FUNCTION trade_fair.crm_group_merge(jsonb,text,text,text) TO trade_fair_dashboard;
ALTER FUNCTION trade_fair.crm_group_ignore(jsonb,text,text,text) OWNER TO neondb_owner;
REVOKE ALL ON FUNCTION trade_fair.crm_group_ignore(jsonb,text,text,text) FROM PUBLIC,trade_fair_dashboard,trade_fair_ai_context;
GRANT EXECUTE ON FUNCTION trade_fair.crm_group_ignore(jsonb,text,text,text) TO trade_fair_dashboard;
ALTER FUNCTION trade_fair.crm_group_split(uuid,text,text) OWNER TO neondb_owner;
REVOKE ALL ON FUNCTION trade_fair.crm_group_split(uuid,text,text) FROM PUBLIC,trade_fair_dashboard,trade_fair_ai_context;
GRANT EXECUTE ON FUNCTION trade_fair.crm_group_split(uuid,text,text) TO trade_fair_dashboard;
ALTER FUNCTION trade_fair.crm_group_extract(uuid,text,text,text) OWNER TO neondb_owner;
REVOKE ALL ON FUNCTION trade_fair.crm_group_extract(uuid,text,text,text) FROM PUBLIC,trade_fair_dashboard,trade_fair_ai_context;
GRANT EXECUTE ON FUNCTION trade_fair.crm_group_extract(uuid,text,text,text) TO trade_fair_dashboard;
ALTER FUNCTION trade_fair.crm_group_revert(uuid,text,text) OWNER TO neondb_owner;
REVOKE ALL ON FUNCTION trade_fair.crm_group_revert(uuid,text,text) FROM PUBLIC,trade_fair_dashboard,trade_fair_ai_context;
GRANT EXECUTE ON FUNCTION trade_fair.crm_group_revert(uuid,text,text) TO trade_fair_dashboard;
ALTER FUNCTION trade_fair.crm_groups_snapshot(integer,integer,boolean,integer) OWNER TO neondb_owner;
REVOKE ALL ON FUNCTION trade_fair.crm_groups_snapshot(integer,integer,boolean,integer) FROM PUBLIC,trade_fair_dashboard,trade_fair_ai_context;
GRANT EXECUTE ON FUNCTION trade_fair.crm_groups_snapshot(integer,integer,boolean,integer) TO trade_fair_dashboard;
ALTER FUNCTION trade_fair.ai_lead_context(jsonb) OWNER TO neondb_owner;
REVOKE ALL ON FUNCTION trade_fair.ai_lead_context(jsonb) FROM PUBLIC,trade_fair_dashboard,trade_fair_ai_context;
GRANT EXECUTE ON FUNCTION trade_fair.ai_lead_context(jsonb) TO trade_fair_ai_context;
REVOKE ALL ON SEQUENCE trade_fair.lead_group_audit_event_no_seq FROM PUBLIC,trade_fair_dashboard,trade_fair_ai_context;
DO $post$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='trade_fair' AND c.relname IN ('lead_groups','lead_group_members','lead_group_audit') AND has_table_privilege('trade_fair_dashboard',c.oid,'SELECT,INSERT,UPDATE,DELETE')) THEN RAISE EXCEPTION 'direct CRM table access forbidden'; END IF;
 IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='trade_fair' AND p.proname LIKE '_crm_%' AND has_function_privilege('trade_fair_dashboard',p.oid,'EXECUTE')) THEN RAISE EXCEPTION 'dashboard must not execute private helpers'; END IF;
 IF has_function_privilege('public','trade_fair.crm_group_merge(jsonb,text,text,text)','EXECUTE') THEN RAISE EXCEPTION 'PUBLIC EXECUTE forbidden'; END IF;
 IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='trade_fair' AND c.relkind IN ('r','p') AND has_table_privilege('trade_fair_ai_context',c.oid,'SELECT,INSERT,UPDATE,DELETE')) THEN RAISE EXCEPTION 'AI context role must not access tables'; END IF;
 IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='trade_fair' AND p.proname<>'ai_lead_context' AND has_function_privilege('trade_fair_ai_context',p.oid,'EXECUTE')) THEN RAISE EXCEPTION 'AI context role must execute only its narrow function'; END IF;
 IF has_function_privilege('trade_fair_ai_context','trade_fair.crm_group_merge(jsonb,text,text,text)','EXECUTE') THEN RAISE EXCEPTION 'AI must not mutate CRM'; END IF;
END $post$;
COMMIT;
