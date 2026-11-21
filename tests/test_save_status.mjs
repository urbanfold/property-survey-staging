import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const resume = app.slice(app.indexOf('async function resumeSurvey(id) {'), app.indexOf('function debounce(', app.indexOf('async function resumeSurvey(id) {')));
assert.ok(resume.length > 100, 'Could not isolate resumeSurvey');

test('cloud reopen refreshes stale signed-out status only after survey loaded', () => {
  const loaded = resume.indexOf("if (!loadDraft(JSON.stringify(restored)))");
  const source = resume.indexOf("showSurveySource(matchingDraft");
  const status = resume.indexOf("setSaveStatus('Saved survey opened from the database.', 'cloud')");
  assert.ok(loaded >= 0 && source > loaded && status > source, 'Cloud status must follow successful load and source message');
  assert.ok(status < resume.indexOf('} catch (error)'), 'Status update must be inside successful try branch');
});

test('device draft reopen is explicitly marked as device-only', () => {
  const draft = resume.indexOf('const openDeviceDraft = () => {');
  const draftLoad = resume.indexOf('if (!loadDraft(saved, id))', draft);
  const draftStatus = resume.indexOf("setSaveStatus('Device draft opened. Save progress to verify changes in the cloud.', 'device')", draft);
  const closure = resume.indexOf('};', draft);
  assert.ok(draft >= 0 && draftLoad > draft && draftStatus > draftLoad && draftStatus < closure);
});

test('signout remains locked and warns about private drafts', () => {
  assert.match(app, /setSaveStatus\('No survey open\. Sign in to access saved surveys\.', 'locked'\)/);
  assert.match(app, /Signed out\. Private device drafts were cleared/);
});
