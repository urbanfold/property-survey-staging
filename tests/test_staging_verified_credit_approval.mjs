// Source-level checks only; Stripe/database integration tests remain required.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../supabase/functions/staging-survey-verify-and-approve-test-credit/index.ts',import.meta.url),'utf8');
test('function is staging-only and requires confirmed authenticated identity',()=>{
  assert.match(src,/hexhtduvqzleoazusskh\.supabase\.co/);
  assert.match(src,/request\.headers\.get\("origin"\) !== ALLOWED_ORIGIN/);
  assert.match(src,/auth\.auth\.getUser\(bearer\)/);
  assert.match(src,/!user\.email_confirmed_at/);
});
test('cross buyer, cross-purpose and live payments are rejected',()=>{
  assert.match(src,/session\.livemode === false/);
  assert.match(src,/session\.client_reference_id === user\.id/);
  assert.match(src,/session\.customer_email\.toLowerCase\(\) === email/);
  assert.match(src,/metadata\.urbanfold_checkout_purpose === "staging_survey_extra_credit"/);
  assert.match(src,/intent\.livemode === false/);
  assert.match(src,/charge\.livemode === false/);
});
test('payment value, final state, charge and refund/dispute are validated',()=>{
  for(const field of ['session.payment_status === "paid"','session.amount_total === 600',
     'intent.status === "succeeded"','intent.amount_received === 600',
     'charge.captured === true','charge.amount_refunded === 0','charge.refunded === false',
     'charge.disputed === false']) assert.ok(src.includes(field),field);
});
test('server-only approval follows verified purchase and does not grant live credit',()=>{
  assert.match(src,/STAGING_STRIPE_TEST_SECRET_KEY/);
  assert.match(src,/SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(src,/db\.rpc\("record_survey_purchase"/);
  assert.match(src,/is_live: false/);
  assert.match(src,/staging_approved_test_survey_credits/);
  assert.doesNotMatch(src,/sk_live_|rk_live_/);
});
