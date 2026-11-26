-- Review-only proposal for Urbanfold staging. Apply with the frontend and verifier changes.
begin;

alter table public.staging_approved_test_survey_credits
  add column redemption_verified_at timestamptz;

grant update (redemption_verified_at) on public.staging_approved_test_survey_credits to service_role;

create or replace function public.staging_survey_credit_for_verification(buyer_id uuid)
returns text
language sql
security definer
set search_path to ''
as $function$
  select p.checkout_session_id
  from public.survey_credit_purchases p
  where p.user_id = buyer_id
    and p.redeemed_property_id is null
    and not exists (
      select 1 from public.survey_credit_revocations r
      where r.payment_intent_id = p.payment_intent_id
    )
    -- The already-deployed staging webhook audits signed refund/dispute events.
    -- Fail closed for ANY such event against an unused test credit, including
    -- pending or closed states: never auto-restore without manual review.
    -- This does NOT cover undelivered events or refund objects missing an
    -- associated PaymentIntent ID; operational review is still required.
    and not exists (
        select 1
        from urbanfold_retention.staging_stripe_webhook_review_events e
        where e.payment_intent_id = p.payment_intent_id
          and e.event_type in (
            'refund.created', 'refund.updated', 'charge.refund.updated',
            'charge.refunded', 'charge.dispute.created',
            'charge.dispute.updated', 'charge.dispute.closed'
          )
    )
    and not p.live_mode
    and exists (
      select 1 from public.staging_approved_test_survey_credits v
      where v.checkout_session_id = p.checkout_session_id
    )
  order by p.purchased_at, p.checkout_session_id
  limit 1
$function$;

revoke all on function public.staging_survey_credit_for_verification(uuid) from public, anon, authenticated;
grant execute on function public.staging_survey_credit_for_verification(uuid) to service_role;

create or replace function public.enforce_survey_allowance()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
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
            and v.redemption_verified_at > clock_timestamp() - interval '60 seconds'
            and v.redemption_verified_at <= clock_timestamp()
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

commit;
