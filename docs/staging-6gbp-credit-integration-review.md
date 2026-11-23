# Urbanfold staging-only £6 survey-credit integration — implementation review

Status: **design and security review only; not a deployable payment change**.

## Current evidence (23 November 2026)

- Normal staging UI at `property-survey-staging` calls `sb.functions.invoke('create-survey-checkout')`, which is not deployed in the staging project; this produces “Payments are not available yet”.
- A separate restricted buyer harness at `property-survey/staging-buyer-checkout.html` calls `staging-buyer-create-checkout`, verifies Stripe test payment and records it with `staging-buyer-record-verified-purchase`. It only accepts the dedicated staging buyer.
- A £6.00 GBP **test-mode** Checkout payment for the dedicated staging buyer was verified and recorded in `survey_credit_purchases` with `live_mode = false` and no redemption.
- The staging database's `get_survey_allowance` and `enforce_survey_allowance` intentionally count only `live_mode = true` purchases. Therefore sandbox purchases **do not** presently provide additional survey allowance. Do not loosen this rule indiscriminately.

## Proposed implementation (separate reviewable changes)

1. Create a **staging-only** checkout endpoint for normal staging authenticated users, not a re-use of the dedicated-buyer function. Require verified email, authenticated session, origin/project validation, strict amount **600 pence GBP**, exact `cs_test_` session and `livemode=false` checks, per-user idempotency and Stripe TEST credentials from server secrets only.
2. Return to **the staging survey URL only**, with Checkout Session ID; client checks payment status via a server endpoint and does **not** grant itself credits by trusting a URL query string.
3. Add a server-side test-payment verification/recording flow with authenticated buyer identity, Stripe API validation of session/payment intent, currency, amount, status, refunds/disputes, and idempotent session/intent uniqueness. Reject unverified, duplicate, refunded or disputed payments.
4. Add a **staging-only allowance mechanism** for verified `live_mode=false` purchases, distinctly isolated from production and clearly named/test-marked; do not change production's `live_mode=true` requirement. Preserve first free survey, atomic credit redemption, one payment per one additional property, and existing pre-rule surveys.
5. Ensure checkout credits cannot be created/updated/redeemed by direct client writes; use server-side privileged operations and least-privilege RPC execution permissions.
6. Handle refunds, chargebacks, failed/cancelled checkouts and retries as explicit states. Confirm redemption/revocation policy with test fixtures and read-only audit before enabling any production payment process.
7. Only after all safety tests pass, connect the normal staging `Buy one additional survey — £6` button and credit refresh. Keep the LIVE repository, website, Stripe keys, webhook settings and survey data unchanged.

## Required automated tests

- First survey free; second survey denied without verified credit.
- £6 test payment for correct staging user, 1 credit available; successful second survey consumes exactly one credit; third requires another.
- Repeated verification/webhook or parallel survey creations cannot double-grant/double-redeem.
- Wrong user, wrong project, unknown session, `cs_live_`, non-GBP/wrong amount, incomplete payment, refunded/disputed payment, unauthenticated calls fail closed.
- Existing surveys continue to load/save; no live-mode credits granted by a sandbox transaction.
- Normal staging checkout cancellation and error messages leave customer data unchanged.
- Browser and database integration tests pass.

## Release gates

- **This PR only documents the intended integration.** It does not connect the normal checkout button or activate any payment capability.
- Follow-up implementation in staging repository and staging Supabase must be separately reviewed and tested before deployment.
- Do not merge staging implementation into live repository or enable Stripe live payments without explicit user approval.
