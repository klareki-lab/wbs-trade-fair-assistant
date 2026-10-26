-- Synthetic isolated fixture from Yuri supplied package; NOT a production migration.
CREATE OR REPLACE FUNCTION trade_fair.get_lead_status(p_lead_id text,p_submission_id text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path=pg_catalog,trade_fair,pg_temp
AS $function$
    SELECT COALESCE((
        SELECT jsonb_build_object(
            'success',true,'lead_id',s.lead_id,
            'processing_status',s.processing_status,'processing_attempts',s.processing_attempts,
            'next_retry_at',s.processing_next_retry_at,'last_error_code',s.last_error_code,
            'review_required',(s.review_required
                OR COALESCE(r.result_payload#>>'{extraction,needs_human_review}','false')='true'
                OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(
                    COALESCE(r.result_payload->'uncertainty_flags','[]'::jsonb)) f(flag)
                    WHERE strpos(f.flag,'structured_ai_conflict')=1)),
            'score_band',r.score_band,'score_total',r.score_total,
            'email_status',e.status,'email_next_retry_at',e.next_retry_at,
            'updated_at',GREATEST(s.processing_updated_at,s.persisted_at,r.created_at,e.updated_at)
        ) FROM trade_fair.lead_submissions s
        LEFT JOIN trade_fair.processing_results r ON r.lead_id=s.lead_id
        LEFT JOIN trade_fair.email_outbox e ON e.lead_id=s.lead_id
        WHERE s.lead_id=p_lead_id AND s.submission_id=p_submission_id
    ),jsonb_build_object('success',false,'error',jsonb_build_object('code','NOT_FOUND','message','Lead not found.')));
$function$;
