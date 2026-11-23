// Static fail-closed checks only. This does not replace integration tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../supabase/functions/create-survey-checkout/index.ts', import.meta.url), 'utf8');

test('staging checkout is pinned to the staging project and domain', () => {
  assert.match(source, /hexhtduvqzleoazusskh\.supabase\.co/);
  assert.match(source, /urbanfold\.github\.io\/property-survey-staging\//);
  assert.match(source, /request\.headers\.get\("origin"\) !== EXPECTED_ORIGIN/);
});

test('checkout requires authenticated confirmed user and payment test mode', () => {
  assert.match(source, /supabase\.auth\.getUser\(bearer\[1\]\)/);
  assert.match(source, /!user\.email_confirmed_at/);
  assert.match(source, /checkout\.livemode !== false/);
  assert.match(source, /TEST_SESSION_ID\.test\(checkout\.id\)/);
  assert.match(source, /checkout\.amount_total !== 600/);
  assert.match(source, /checkout\.currency !== "gbp"/);
});

test('checkout does not grant survey credits or use a live Stripe key', () => {
  assert.match(source, /credit_granted: false/);
  assert.match(source, /STAGING_STRIPE_CHECKOUT_SECRET_KEY/);
  assert.doesNotMatch(source, /sk_live_|rk_live_/);
  assert.doesNotMatch(source, /survey_credit_purchases|record_survey_purchase|service_role/);
});

test('staging checkout return verifies with the server before showing credit', () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(app, /staging-survey-verify-and-approve-test-credit/);
  assert.match(app, /data\?\.verified !== true \|\| data\?\.approved !== true/);
  assert.match(app, /await checkPurchasedCredit\(\)/);
  assert.match(app, /Test payment credit is not confirmed/);
});
