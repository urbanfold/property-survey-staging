-- REVIEW ONLY. STAGING SUPABASE PROJECT hexhtduvqzleoazusskh.
-- Do not apply to live. This migration is NOT deployed by this PR.
-- This file is deliberately NOT in a migrations directory so no automated
-- deployment process will execute it.
-- Requires a separately reviewed server-side Stripe verification flow
-- that grants approval ONLY after verifying a paid test-mode GBP 600
-- Stripe checkout for the authenticated staging user, unrefunded/undisputed.

begin;

create table if not exists public.staging_approved_test_survey_credits (
  checkout_session_id text primary key
    references public.survey_credit_purchases(checkout_session_id) on delete restrict,
  approved_at timestamptz not null default now(),
  proof_kind text not null check (proof_kind = 'stripe_test_payment_verified'),
  constraint staging_approved_session_test_id
    check (checkout_session_id ~ '^cs_test_[A-Za-z0-9]+$')
);
alter table public.staging_approved_test_survey_credits enable row level security;
revoke all on public.staging_approved_test_survey_credits from public, anon, authenticated;
grant select, insert on public.staging_approved_test_survey_credits to service_role;
-- No user-facing write policies. A trusted server must independently validate
-- Stripe payment and purchaser before inserting approval into this table.
-- Historic sandbox purchases remain INELIGIBLE unless specifically approved.

create or replace function public.get_survey_allowance()
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  person uuid := auth.uid();
  is_admin boolean := coalesce(auth.jwt()->>'email' = 'urbanfolduk@gmail.com', false);
  staging_claim boolean := coalesce(
    auth.jwt()->>'iss' = 'https://hexhtduvqzleoazusskh.supabase.co/auth/v1', false);
  free_available boolean;
  credits bigint;
begin
  if person is null then raise exception 'Sign in to check your survey allowance.'; end if;
  select not exists(
    select 1 from public.survey_free_allocations where user_id = person
  ) into free_available;
  select count(*) into credits
  from public.survey_credit_purchases p
  where p.user_id = person
    and p.redeemed_property_id is null
    and not exists (
      select 1 from public.survey_credit_revocations r
      where r.payment_intent_id = p.payment_intent_id
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
    );
  return jsonb_build_object('unlimited', is_admin, 'free_available', free_available,
    'paid_credits', credits, 'can_create', is_admin or free_available or credits > 0,
    'price_pence', 600, 'currency', 'GBP');
end
$function$;

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

commit;

-- Required before deployment:
-- (1) verify current staging JWT issuer is exactly the hard-coded staging URL;
-- (2) verify test-session approvals cannot be inserted by anon/authenticated;
-- (3) verify only a Stripe-verified server action can approve each test payment;
-- (4) test first survey, second survey credit consumption, third survey rejection;
-- (5) test old unapproved payments, refund revocation, parallel requests, duplicate
--     payment verification, buyer mismatch, and missing JWT issuer.
-- The checks in this file are not proof of real Stripe payment status.
