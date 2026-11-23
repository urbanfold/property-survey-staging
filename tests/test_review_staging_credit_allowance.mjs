// Review-only static safety checks. These DO NOT test real database behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const sql = readFileSync(new URL('../docs/review-only-staging-test-credit-allowance.sql', import.meta.url), 'utf8');

test('sandbox credit approval is isolated and denied to ordinary clients', () => {
  assert.match(sql,/create table if not exists public\.staging_approved_test_survey_credits/);
  assert.match(sql,/enable row level security/);
  assert.match(sql,/revoke all on public\.staging_approved_test_survey_credits from public, anon, authenticated/);
  assert.doesNotMatch(sql,/grant\s+(?:insert|update|delete)[^\n]*to\s+authenticated/i);
  assert.match(sql,/proof_kind text not null check \(proof_kind = 'stripe_test_payment_verified'\)/);
});

test('only explicitly approved sandbox purchases may count', () => {
  assert.match(sql,/p\.redeemed_property_id is null/g);
  assert.match(sql,/staging_claim and not p\.live_mode/g);
  assert.match(sql,/auth\.jwt\(\)->>'iss' = 'https:\/\/hexhtduvqzleoazusskh\.supabase\.co\/auth\/v1'/g);
  assert.match(sql,/select 1 from public\.staging_approved_test_survey_credits v/g);
  assert.match(sql,/survey_credit_revocations/g);
});

test('one redemption is atomic and existing free allowance remains', () => {
  assert.match(sql,/from auth\.users where id = new\.user_id for update/);
  assert.match(sql,/on conflict\(user_id\) do nothing/);
  assert.match(sql,/for update of p/);
  assert.match(sql,/redeemed_property_id = new\.id, redeemed_at = now\(\)/);
  assert.match(sql,/URBANFOLD_SURVEY_LIMIT/);
});

test('never deploy review SQL automatically', () => {
  assert.match(sql,/REVIEW ONLY/);
  assert.match(sql,/NOT deployed/);
});

test('recorded refund/dispute webhook events block unused staging test credits', () => {
  const holds = sql.match(/urbanfold_retention\.staging_stripe_webhook_review_events e/g) || [];
  assert.equal(holds.length, 2, 'both allowance and insert trigger need an event hold');
  for (const eventType of ['refund.created', 'refund.updated', 'charge.refund.updated',
    'charge.refunded', 'charge.dispute.created', 'charge.dispute.updated',
    'charge.dispute.closed']) {
    const occurrences = sql.split("'" + eventType + "'").length - 1;
    assert.equal(occurrences, 2, eventType + ' should be in both eligibility checks');
  }
  assert.match(sql, /e\.payment_intent_id = p\.payment_intent_id/);
  assert.match(sql, /undelivered events or refund objects missing an/);
});
