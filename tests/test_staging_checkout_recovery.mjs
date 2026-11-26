import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const paymentCode = app.slice(app.indexOf('        let checkingPurchasedCredit'), app.indexOf('        async function startNewSurvey'));
const checkout = 'cs_test_fixture';
const returnQuery = '?payment=success&checkout_session_id=' + checkout;

function dashboard({ search = '', storage = new Map(), userId = 'buyer', verify = async () => ({
    data: { verified: true, approved: true }
}), allowance = async () => ({ paid_credits: 1 }) } = {}) {
    const nodes = new Map();
    const calls = [];
    const location = { search, pathname: '/stage/', hash: '' };
    const context = createContext({
        location, URLSearchParams,
        history: { replaceState(_, __, url) { location.search = new URL(url, 'https://example.test').search; } },
        currentUser: { id: userId },
        localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
        sessionStorage: { removeItem() {} },
        document: { getElementById(id) {
            if (!nodes.has(id)) nodes.set(id, { hidden: true });
            return nodes.get(id);
        } },
        sessionContext: () => ({ userId }),
        sessionIsCurrent: session => session.userId === context.currentUser.id,
        checkSession(session) {
            if (session.userId !== context.currentUser.id) throw new Error('Session changed');
        },
        requireResult: promise => promise,
        sb: { functions: { invoke(_, { body }) {
            calls.push(body.checkout_session_id);
            return verify();
        } }, rpc: allowance },
    });
    runInContext(paymentCode, context);
    return { context, calls, location, storage, notice: () => nodes.get('payment-notice')?.textContent };
}

test('closing the tab before verification completes preserves the reference for the same buyer', async () => {
    const original = dashboard({ search: returnQuery + '&keep=1', verify: () => new Promise(() => {}) });
    void original.context.handlePaymentReturn();
    assert.deepEqual(original.calls, [checkout]);
    assert.equal(original.location.search, '?keep=1');

    const other = dashboard({ storage: original.storage, userId: 'other' });
    await other.context.handlePaymentReturn();
    assert.deepEqual(other.calls, []);

    const reopened = dashboard({ storage: original.storage });
    await reopened.context.handlePaymentReturn();
    assert.deepEqual(reopened.calls, [checkout]);
    assert.match(reopened.notice(), /Payment confirmed/);
    assert.equal(original.storage.size, 0);
    await reopened.context.handlePaymentReturn();
    assert.deepEqual(reopened.calls, [checkout]);
});

test('manual retry re-verifies a failed return before reading the allowance', async () => {
    let failures = 1;
    let allowanceReads = 0;
    const page = dashboard({ search: returnQuery, verify: async () => failures--
        ? { error: new Error('Temporary failure') }
        : { data: { verified: true, approved: true } },
    allowance: async () => { allowanceReads++; return { paid_credits: 1 }; } });
    await page.context.handlePaymentReturn();
    assert.match(page.notice(), /not confirmed/);
    assert.equal(allowanceReads, 0);
    await page.context.checkPurchasedCredit();
    assert.deepEqual(page.calls, [checkout, checkout]);
    assert.equal(allowanceReads, 1);
    assert.match(page.notice(), /Payment confirmed/);
});

test('cancellation remains visible without calling payment verification', async () => {
    const page = dashboard({ search: '?payment=cancelled' });
    await page.context.handlePaymentReturn();
    assert.match(page.notice(), /Checkout was cancelled/);
    assert.equal(page.location.search, '');
    assert.deepEqual(page.calls, []);
});

test('if storage is unavailable the current return URL supports retry', async () => {
    let failures = 1;
    const page = dashboard({ search: returnQuery, verify: async () => failures--
        ? { error: new Error('Temporary failure') }
        : { data: { verified: true, approved: true } } });
    page.context.localStorage = {
        setItem() { throw new Error('Storage disabled'); },
        getItem() { throw new Error('Storage disabled'); },
    };
    await page.context.handlePaymentReturn();
    assert.equal(page.location.search, returnQuery);
    await page.context.checkPurchasedCredit();
    assert.deepEqual(page.calls, [checkout, checkout]);
    assert.equal(page.location.search, '');
    assert.match(page.notice(), /Payment confirmed/);
});
