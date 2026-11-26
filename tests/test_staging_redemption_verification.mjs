import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const app = read('../app.js');
const saveCode = app.slice(app.indexOf('        let savingDetails = false;'), app.indexOf('        const elevationsMap'));
const sql = read('../docs/review-only-staging-credit-redemption-verification.sql');
const edge = read('../supabase/functions/staging-survey-verify-and-approve-test-credit/index.ts');

for (const scenario of [
    { name: 'verified paid credit saves', paid: true, verified: true, calls: ['verify', 'save'] },
    { name: 'failed verification prevents save', paid: true, verified: false, calls: ['verify', 'alert'] },
    { name: 'free allocation saves without payment verification', paid: false, verified: false, calls: ['save'] },
]) {
    test(scenario.name, async () => {
        const calls = [];
        const property = {
            upsert() { calls.push('save'); return this; },
            select() { return this; },
            single: async () => ({ id: 'fixture-property' }),
        };
        const context = {
            currentUser: { id: 'fixture-user' }, currentPropertyId: null, newPropertyId: null,
            crypto: { randomUUID: () => 'fixture-property' },
            sessionContext() {}, checkSession() {}, sessionIsCurrent: () => true,
            document: { getElementById: () => ({ value: 'fixture' }) },
            setLoading() {}, saveDraft() {}, showView() {}, alert: () => calls.push('alert'),
            readSurveyAllowance: async () => ({ free_available: !scenario.paid, paid_credits: 1 }),
            requireResult: promise => promise,
            sb: { from: () => property, functions: { async invoke(_, { body }) {
                assert.equal(body.prepare_redemption, true);
                calls.push('verify');
                return { data: { redemption_ready: scenario.verified } };
            } } },
        };
        await runInNewContext(saveCode + '\nsaveDetails()', context);
        assert.deepEqual(calls, scenario.calls);
    });
}

test('staging redemption requires server-written recent proof alongside refund checks', () => {
    assert.match(sql, /revoke all on function public\.staging_survey_credit_for_verification\(uuid\) from public, anon, authenticated/i);
    assert.match(sql, /redemption_verified_at > clock_timestamp\(\) - interval '60 seconds'/);
    assert.match(sql, /redemption_verified_at <= clock_timestamp\(\)/);
    assert.match(sql, /charge\.refunded/);
    assert.match(sql, /for update of p/);
    assert.ok(edge.indexOf('if (prepareRedemption)', edge.indexOf('if (!valid)')) < edge.indexOf('.update({ redemption_verified_at:'));
    assert.match(edge, /buyer_id: user\.id/);
});
