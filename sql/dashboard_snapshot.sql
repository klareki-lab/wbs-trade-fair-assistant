-- OPTIONAL REVIEWED MIGRATION: DO NOT EXECUTE ON PRODUCTION WITHOUT NEON DDL/ACL REVIEW.
-- Installs one SECURITY DEFINER read-only function, grants EXECUTE only to the
-- dedicated existing role, does not modify data, create roles/tables or grant SELECT.
\set ON_ERROR_STOP on
BEGIN;
CREATE FUNCTION trade_fair.dashboard_snapshot(
  p_limit integer,p_offset integer,p_search text,p_band text,p_processing text,
  p_email text,p_duplicate text,p_sort text,p_direction text
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, trade_fair, pg_temp
AS $fn$
WITH allowed AS (
 SELECT
  LEAST(GREATEST(COALESCE(p_limit,50),1),100) AS n,
  LEAST(GREATEST(COALESCE(p_offset,0),0),1000000) AS skip,
  LEFT(COALESCE(p_search,''),120) AS q,
  COALESCE(p_band,'') AS band,
  COALESCE(p_processing,'') AS process,
  COALESCE(p_email,'') AS email,
  COALESCE(p_duplicate,'') AS duplicate,
  CASE WHEN p_sort IN ('company','score','processing','email') THEN p_sort ELSE 'created' END AS sort,
  CASE WHEN p_direction='asc' THEN 'asc' ELSE 'desc' END AS dir
),
base AS (
 SELECT s.lead_id, s.company_id, s.contact_id, c.company_name, c.website,
  t.contact_name,t.email,t.phone,t.email_verified,
  s.source,s.created_at,s.processing_status,s.processing_attempts,s.last_error_code,
  s.duplicate_status,s.review_required,s.uncertainty_flags,s.possible_contact_ids,
  s.normalized_payload,r.score_band,r.score_total,r.result_payload,r.created_at AS scored_at,
  e.status AS email_status,e.last_error_code AS email_error_code,e.updated_at AS email_updated_at
 FROM trade_fair.lead_submissions s
 JOIN trade_fair.companies c ON c.company_id=s.company_id
 LEFT JOIN trade_fair.contacts t ON t.contact_id=s.contact_id
 LEFT JOIN trade_fair.processing_results r ON r.lead_id=s.lead_id
 LEFT JOIN trade_fair.email_outbox e ON e.lead_id=s.lead_id
),
filtered AS (
 SELECT b.* FROM base b CROSS JOIN allowed a
 WHERE (a.q='' OR b.company_name ILIKE '%'||a.q||'%'
  OR COALESCE(b.contact_name,'') ILIKE '%'||a.q||'%'
  OR COALESCE(b.email,'') ILIKE '%'||a.q||'%'
  OR b.lead_id ILIKE '%'||a.q||'%')
 AND (a.band='' OR (a.band='UNSCORED' AND b.score_band IS NULL) OR b.score_band=a.band)
 AND (a.process='' OR b.processing_status=a.process)
 AND (a.email='' OR (a.email='none' AND b.email_status IS NULL) OR b.email_status=a.email)
 AND (a.duplicate='' OR (a.duplicate='yes' AND b.duplicate_status<>'NEW') OR (a.duplicate='no' AND b.duplicate_status='NEW'))
),
ranked AS (
 SELECT f.*,ROW_NUMBER() OVER (ORDER BY
  CASE WHEN a.sort='company' AND a.dir='asc' THEN f.company_name END ASC NULLS LAST,
  CASE WHEN a.sort='company' AND a.dir='desc' THEN f.company_name END DESC NULLS LAST,
  CASE WHEN a.sort='score' AND a.dir='asc' THEN f.score_total END ASC NULLS LAST,
  CASE WHEN a.sort='score' AND a.dir='desc' THEN f.score_total END DESC NULLS LAST,
  CASE WHEN a.sort='processing' AND a.dir='asc' THEN f.processing_status END ASC NULLS LAST,
  CASE WHEN a.sort='processing' AND a.dir='desc' THEN f.processing_status END DESC NULLS LAST,
  CASE WHEN a.sort='email' AND a.dir='asc' THEN f.email_status END ASC NULLS LAST,
  CASE WHEN a.sort='email' AND a.dir='desc' THEN f.email_status END DESC NULLS LAST,
  CASE WHEN a.sort='created' AND a.dir='asc' THEN f.created_at END ASC NULLS LAST,
  CASE WHEN a.sort='created' AND a.dir='desc' THEN f.created_at END DESC NULLS LAST,
  f.lead_id ASC) AS ordinal
 FROM filtered f CROSS JOIN allowed a
),
selected AS (
 SELECT * FROM ranked ORDER BY ordinal
 LIMIT (SELECT n FROM allowed) OFFSET (SELECT skip FROM allowed)
)
SELECT jsonb_build_object(
 'total',(SELECT count(*) FROM filtered),
 'as_of',statement_timestamp(),
 'stats',(
 SELECT jsonb_build_object(
 'total',count(*),
 'hot',count(*) FILTER (WHERE score_band='HOT'),
 'warm',count(*) FILTER (WHERE score_band='WARM'),
 'cold',count(*) FILTER (WHERE score_band='COLD'),
 'unscored',count(*) FILTER (WHERE score_band IS NULL),
 'duplicates',count(*) FILTER (WHERE duplicate_status<>'NEW'),
 'failed',count(*) FILTER (WHERE processing_status='failed'),
 'email_attention',count(*) FILTER (WHERE email_status IN ('failed','uncertain')),
 'scored_average',round(avg(score_total),1),
 'today',count(*) FILTER (WHERE (created_at AT TIME ZONE 'Europe/Berlin')::date=(statement_timestamp() AT TIME ZONE 'Europe/Berlin')::date),
 'interests',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',x.topic,'count',x.n) ORDER BY x.n DESC,x.topic),'[]'::jsonb)
  FROM (SELECT COALESCE(NULLIF(normalized_payload->>'training_interest',''),'Unbekannt') AS topic,count(*) AS n
    FROM base GROUP BY 1 ORDER BY n DESC,topic LIMIT 20) x)
 ) FROM base),
 'leads',COALESCE((SELECT jsonb_agg(jsonb_build_object(
 'lead_id',lead_id,'company_id',company_id,'contact_id',contact_id,
 'company',company_name,'website',website,'contact',contact_name,'email',email,
 'phone',phone,'email_verified',email_verified,'source',source,'created_at',created_at,
 'processing_status',processing_status,'processing_attempts',processing_attempts,
 'processing_error',last_error_code,'duplicate_status',duplicate_status,
 'review_required',review_required,'uncertainty_flags',uncertainty_flags,
 'possible_contact_ids',possible_contact_ids,
 'training_interest',normalized_payload->>'training_interest',
 'budget_status',normalized_payload->>'budget_status',
 'follow_up',normalized_payload->>'follow_up',
 'follow_up_date',normalized_payload->>'follow_up_date',
 'notes',normalized_payload->>'notes',
 'score_band',score_band,'score_total',score_total,'scored_at',scored_at,
 'company_research',result_payload->'company_research',
 'ai_extraction',result_payload->'extraction',
 'ai_uncertainty',result_payload->'uncertainty_flags',
 'email_status',email_status,'email_error',email_error_code,
 'email_updated_at',email_updated_at
 ) ORDER BY ordinal) FROM selected),'[]'::jsonb)
);
$fn$;
REVOKE ALL ON FUNCTION trade_fair.dashboard_snapshot(integer,integer,text,text,text,text,text,text,text) FROM PUBLIC;
GRANT USAGE ON SCHEMA trade_fair TO trade_fair_dashboard;
GRANT EXECUTE ON FUNCTION trade_fair.dashboard_snapshot(integer,integer,text,text,text,text,text,text,text) TO trade_fair_dashboard;
COMMIT;
