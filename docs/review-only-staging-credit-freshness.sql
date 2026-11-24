-- STAGING REVIEW ONLY. Do not apply to production.
-- Preserve staging issuer, approval and refund-audit checks.
BEGIN;
ALTER TABLE public.survey_credit_purchases ADD COLUMN staging_stripe_verified_at timestamptz;
CREATE FUNCTION public.attest_staging_survey_credit(session_id text,intent_id text,buyer_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $$
BEGIN
 IF session_id IS NULL OR session_id !~ '^cs_test_[A-Za-z0-9]+$'
 OR intent_id IS NULL OR intent_id !~ '^pi_[A-Za-z0-9]+$' OR buyer_id IS NULL THEN
 RAISE EXCEPTION 'Invalid staging verification reference';
 END IF;
 PERFORM 1 FROM auth.users WHERE id=buyer_id FOR UPDATE;
 UPDATE public.survey_credit_purchases p SET staging_stripe_verified_at=clock_timestamp()
 WHERE p.checkout_session_id=session_id AND p.payment_intent_id=intent_id
 AND p.user_id=buyer_id AND NOT p.live_mode AND p.redeemed_property_id IS NULL
 AND EXISTS (SELECT 1 FROM public.staging_approved_test_survey_credits v WHERE v.checkout_session_id=p.checkout_session_id)
 AND NOT EXISTS (SELECT 1 FROM public.survey_credit_revocations r WHERE r.payment_intent_id=p.payment_intent_id)
 AND NOT EXISTS (SELECT 1 FROM urbanfold_retention.staging_stripe_webhook_review_events e
 WHERE e.payment_intent_id=p.payment_intent_id AND e.event_type IN
 ('refund.created','refund.updated','charge.refund.updated','charge.refunded','charge.dispute.created','charge.dispute.updated','charge.dispute.closed'));
END $$;
REVOKE ALL ON FUNCTION public.attest_staging_survey_credit(text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.attest_staging_survey_credit(text,text,uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.enforce_survey_allowance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  allocated uuid;
  purchase text;
  caller_role text := auth.jwt()->>'role';
  staging_claim boolean := coalesce(
    auth.jwt()->>'iss' = 'https://hexhtduvqzleoazusskh.supabase.co/auth/v1', false);
begin
  -- Preserve existing privileged/admin behaviour.
  if caller_role = 'service_role' or (caller_role is null and auth.uid() is null)
     or (auth.uid() is not null and auth.jwt()->>'email' = 'urbanfolduk@gmail.com')
     then return new; end if;
  if auth.uid() is null or new.user_id is distinct from auth.uid() then
    raise exception 'Survey ownership is invalid.' using errcode = '42501';
  end if;
  -- Serialise concurrent creation and credit redemption on the same account.
  perform 1 from auth.users where id = new.user_id for update;
  if exists(
    select 1 from public.properties where id = new.id and user_id = new.user_id
  ) then return new; end if;
  insert into public.survey_free_allocations(user_id, property_id)
    values(new.user_id, new.id) on conflict(user_id) do nothing
    returning user_id into allocated;
  if allocated is not null then return new; end if;
  select p.checkout_session_id into purchase
  from public.survey_credit_purchases p
  where p.user_id = new.user_id
    and p.redeemed_property_id is null
    and (p.live_mode or (p.staging_stripe_verified_at >= clock_timestamp() - interval '120 seconds'
      and p.staging_stripe_verified_at <= clock_timestamp()))
    and not exists (
      select 1 from public.survey_credit_revocations r
      where r.payment_intent_id = p.payment_intent_id
    )
    -- The already-deployed staging webhook audits signed refund/dispute events.
    -- Fail closed for ANY such event against an unused test credit, including
    -- pending or closed states: never auto-restore without manual review.
    -- This does NOT cover undelivered events or refund objects missing an
    -- associated PaymentIntent ID; operational review is still required.
    and (
      p.live_mode or not exists (
        select 1
        from urbanfold_retention.staging_stripe_webhook_review_events e
        where e.payment_intent_id = p.payment_intent_id
          and e.event_type in (
            'refund.created', 'refund.updated', 'charge.refund.updated',
            'charge.refunded', 'charge.dispute.created',
            'charge.dispute.updated', 'charge.dispute.closed'
          )
      )
    )
    and (
      p.live_mode
      or (
        staging_claim and not p.live_mode
        and exists (
          select 1 from public.staging_approved_test_survey_credits v
          where v.checkout_session_id = p.checkout_session_id
        )
      )
    )
  order by p.purchased_at, p.checkout_session_id
  for update of p
  limit 1;
  if purchase is null then
    raise exception 'URBANFOLD_SURVEY_LIMIT' using errcode = 'P0001';
  end if;
  update public.survey_credit_purchases
    set redeemed_property_id = new.id, redeemed_at = now()
    where checkout_session_id = purchase;
  return new;
end
$function$;
-- Service-only recovery selection. Filter consumed/revoked records BEFORE limiting.
CREATE FUNCTION public.list_staging_recoverable_survey_sessions(buyer_id uuid, session_reference text DEFAULT NULL)
RETURNS TABLE(checkout_session_id text,user_id uuid,live_mode boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $$
 WITH candidates AS (
   SELECT p.checkout_session_id,p.user_id,p.live_mode,0 AS priority,p.purchased_at AS sort_time
   FROM public.survey_credit_purchases p
   WHERE p.user_id=buyer_id AND NOT p.live_mode AND p.redeemed_property_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM public.survey_credit_revocations r WHERE r.payment_intent_id=p.payment_intent_id)
     AND NOT EXISTS (SELECT 1 FROM urbanfold_retention.staging_stripe_webhook_review_events e WHERE e.payment_intent_id=p.payment_intent_id AND e.event_type IN ('refund.created','refund.updated','charge.refund.updated','charge.refunded','charge.dispute.created','charge.dispute.updated','charge.dispute.closed'))
     AND (session_reference IS NULL OR p.checkout_session_id=session_reference)
   UNION ALL
   SELECT t.checkout_session_id,t.user_id,false,1,-1 * extract(epoch FROM t.created_at) * interval '1 second' + timestamptz 'epoch'
   FROM public.staging_survey_checkout_attempts t
   WHERE t.user_id=buyer_id AND TRUE
     AND NOT EXISTS (SELECT 1 FROM public.survey_credit_purchases p WHERE p.checkout_session_id=t.checkout_session_id)
     AND (session_reference IS NOT NULL OR t.created_at >= now()-interval '30 days')
     AND (session_reference IS NULL OR t.checkout_session_id=session_reference)
 )
 SELECT c.checkout_session_id,c.user_id,c.live_mode FROM candidates c
 ORDER BY c.priority,c.sort_time,c.checkout_session_id LIMIT 6;
$$;
REVOKE ALL ON FUNCTION public.list_staging_recoverable_survey_sessions(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.list_staging_recoverable_survey_sessions(uuid,text) TO service_role;

COMMIT;
-- Review only. Restore captured original trigger before removing function/column.
-- Verify column grants, save paths, concurrency and older credits before deployment.
