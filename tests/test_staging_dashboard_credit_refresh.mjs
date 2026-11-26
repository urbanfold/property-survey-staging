import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('let checkingPurchasedCredit = false;'), src.indexOf('        function clearPaymentReturnUrl()'));
function setup() {
    const notice = {textContent: 'Payment confirmed', hidden: false};
    const button = {hidden: true, disabled: false};
    const state = {current: true, calls: 0, allowance: {paid_credits: 0}};
    const ctx = vm.createContext({
        currentUser: {id: 'test-user'}, sessionContext: () => ({}),
        sessionIsCurrent: () => state.current,
        checkSession: () => {if (!state.current) throw Error('session changed');},
        document: {getElementById: id => id === 'payment-notice' ? notice : button},
        sb: {rpc: () => {state.calls++; return state.allowance;}},
        requireResult: async operation => await operation,
    });
    vm.runInContext(block, ctx);
    const ready = () => vm.runInContext('paymentNoticeReady = true', ctx);
    const refresh = () => vm.runInContext('refreshConfirmedCreditNotice()', ctx);
    return {notice, button, state, ctx, ready, refresh};
}
test('Back to Dashboard reloads the saved survey list', () => {
    assert.match(html, /onclick="loadDashboard\(\)">Back to Dashboard/);
    const dashboard = src.slice(src.indexOf('async function loadDashboard()'), src.indexOf('function readableRooms'));
    assert.match(dashboard, /sb\.from\('properties'\)\.select\('\*'\)/);
    assert.match(dashboard, /refreshConfirmedCreditNotice\(context\)/);
});
test('consumed credit clears only confirmed availability notice', async () => {
    const s = setup(); s.ready(); await s.refresh();
    assert.equal(s.notice.hidden, true);
    assert.equal(s.notice.textContent, '');
    assert.equal(s.button.hidden, true);
});
test('remaining credits preserve confirmation', async () => {
    const s = setup(); s.ready(); s.state.allowance = {paid_credits: 1}; await s.refresh();
    assert.equal(s.notice.hidden, false);
    assert.equal(s.notice.textContent, 'Payment confirmed');
});
test('pending or failed verification is not cleared or refreshed', async () => {
    const s = setup(); s.notice.textContent = 'Pending confirmation'; await s.refresh();
    assert.equal(s.state.calls, 0); assert.equal(s.notice.textContent, 'Pending confirmation');
});
test('failed allowance refresh offers retry instead of stale confirmation', async () => {
    const s = setup(); s.ready(); s.state.allowance = null; await s.refresh();
    assert.match(s.notice.textContent, /could not be refreshed/); assert.equal(s.button.hidden, false);
});
test('late refresh cannot modify notice after account change', async () => {
    const s = setup(); s.ready(); let resolve;
    s.state.allowance = new Promise(r => {resolve = r;});
    const pending = s.refresh();
    s.state.current = false; vm.runInContext('resetPaymentNotice()', s.ctx);
    s.notice.textContent = 'Other account'; s.notice.hidden = false;
    resolve({paid_credits: 0}); await pending;
    assert.equal(s.notice.textContent, 'Other account'); assert.equal(s.notice.hidden, false);
});
test('logout clears payment notice', () => {
    const s = setup(); s.ready(); vm.runInContext('resetPaymentNotice()', s.ctx);
    assert.equal(s.notice.hidden, true); assert.equal(s.notice.textContent, '');
    assert.match(src.slice(src.indexOf('function clearPrivateSession'), src.indexOf('let currentUser = null')), /resetPaymentNotice\(\)/);
});
