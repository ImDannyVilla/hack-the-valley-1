import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileGeneral } from '../scripts/sync-general-segment.mjs';

function resendFixture({ general = ['a@example.com'], contacts = ['a@example.com', 'b@example.com'], name = 'General' } = {}) {
  const calls = [];
  const members = new Set(general);
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method || 'GET' });
    if (init.method === 'POST') {
      members.add(decodeURIComponent(path.split('/')[2]));
      return Response.json({ id: 'seg_general' });
    }
    if (path === '/segments') return Response.json({ data: [{ id: 'seg_general', name }] });
    const emails = path === '/contacts' ? contacts : path === '/segments/seg_general/contacts' ? [...members] : null;
    if (!emails) throw new Error(`Unexpected fixture URL: ${path}`);
    return Response.json({ data: emails.map((email, index) => ({ id: `ct_${index}`, email })), has_more: false });
  };
  return { fetcher, calls, members };
}

test('dry run counts missing contacts without modifying General', async () => {
  const fixture = resendFixture();
  const result = await reconcileGeneral({ apiKey: 'test', segmentId: 'seg_general', fetcher: fixture.fetcher });
  assert.deepEqual(result, { total: 2, members: 1, missing: 1, applied: 0, dryRun: true });
  assert.equal(fixture.calls.filter((call) => call.method === 'POST').length, 0);
});

test('apply fills General and reads back exact membership; retry is a no-op', async () => {
  const fixture = resendFixture();
  const input = { apiKey: 'test', segmentId: 'seg_general', fetcher: fixture.fetcher, apply: true, consentEmails: ['a@example.com', 'b@example.com'] };
  assert.deepEqual(await reconcileGeneral(input), { total: 2, members: 2, missing: 0, applied: 1, dryRun: false });
  assert.deepEqual(await reconcileGeneral(input), { total: 2, members: 2, missing: 0, applied: 0, dryRun: false });
  assert.equal(fixture.calls.filter((call) => call.method === 'POST').length, 1);
});

test('apply requires verified consent and leaves unapproved global contacts untouched', async () => {
  const fixture = resendFixture({ general: [], contacts: ['a@example.com', 'b@example.com'] });
  const input = { apiKey: 'test', segmentId: 'seg_general', fetcher: fixture.fetcher, apply: true };
  await assert.rejects(reconcileGeneral(input), /verified opt-in/);
  const result = await reconcileGeneral({ ...input, consentEmails: ['a@example.com'] });
  assert.deepEqual(result, { total: 2, members: 1, missing: 1, applied: 1, dryRun: false });
  assert.deepEqual([...fixture.members], ['a@example.com']);
});

test('refuses an incorrect segment ID/name and never sends a broadcast', async () => {
  const fixture = resendFixture({ name: 'Event 2026' });
  await assert.rejects(reconcileGeneral({ apiKey: 'test', segmentId: 'seg_general', fetcher: fixture.fetcher, apply: true, consentEmails: [] }), /not named General/);
  assert.equal(fixture.calls.filter((call) => call.method === 'POST').length, 0);
});
