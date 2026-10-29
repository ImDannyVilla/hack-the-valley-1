// Reconcile Resend's General segment with global Contacts. Read-only by default.
// Apply requires a private JSON file of verified opt-in emails; never infer
// mailing consent from mere presence in Resend's global Contacts.
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

async function list(fetcher, apiKey, path) {
  const items = [];
  let after = '';
  for (let page = 0; page < 100; page += 1) {
    const url = new URL(path, 'https://api.resend.com');
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);
    const response = await fetcher(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!response.ok) throw new Error(`Resend ${path} returned HTTP ${response.status}.`);
    const body = await response.json();
    if (!Array.isArray(body.data)) throw new Error(`Resend ${path} returned an invalid list.`);
    items.push(...body.data);
    if (!body.has_more) return items;
    after = body.data.at(-1)?.id;
    if (!after) throw new Error(`Resend ${path} pagination ended without a cursor.`);
  }
  throw new Error(`Resend ${path} exceeded the pagination limit; refusing a partial reconciliation.`);
}

export async function reconcileGeneral({ apiKey, segmentId, fetcher = fetch, apply = false, consentEmails = null }) {
  if (!apiKey || !segmentId) throw new Error('RESEND_API_KEY and RESEND_ALL_CONTACTS_SEGMENT_ID are required.');
  if (apply && !Array.isArray(consentEmails)) throw new Error('Apply requires a verified opt-in email list.');
  const segments = await list(fetcher, apiKey, '/segments');
  if (!segments.some((segment) => segment.id === segmentId && segment.name?.trim().toLowerCase() === 'general')) {
    throw new Error('Configured segment ID is not named General; refusing to reconcile the wrong audience.');
  }
  const path = `/segments/${encodeURIComponent(segmentId)}/contacts`;
  const contacts = await list(fetcher, apiKey, '/contacts');
  const members = await list(fetcher, apiKey, path);
  const emails = (rows) => new Map(rows.map((row) => [String(row.email || '').trim().toLowerCase(), row]).filter(([email]) => email));
  const global = emails(contacts);
  const current = emails(members);
  if (global.size !== contacts.length || current.size !== members.length) throw new Error('Missing or duplicate email in Resend response; refusing partial reconciliation.');
  const missing = [...global.keys()].filter((email) => !current.has(email));
  const extra = [...current.keys()].filter((email) => !global.has(email));
  if (extra.length) throw new Error('General contains contacts outside the global contact list; inspect Resend before changing membership.');
  if (!apply) return { total: global.size, members: current.size, missing: missing.length, applied: 0, dryRun: true };
  const approved = new Set(consentEmails.map((value) => String(value).trim().toLowerCase()));
  if (approved.has('') || [...approved].some((email) => !global.has(email))) throw new Error('Opt-in list contains invalid or unknown Resend contacts.');
  const eligible = missing.filter((email) => approved.has(email));
  for (const email of eligible) {
    const response = await fetcher(`https://api.resend.com/contacts/${encodeURIComponent(email)}/segments/${encodeURIComponent(segmentId)}`, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok && response.status !== 409) throw new Error(`Segment add failed with HTTP ${response.status}; rerun to reconcile remaining contacts.`);
  }
  const finalMembers = emails(await list(fetcher, apiKey, path));
  const remaining = eligible.filter((email) => !finalMembers.has(email));
  if (remaining.length) throw new Error(`Readback mismatch: ${remaining.length} approved contacts missing; rerun after inspecting Resend.`);
  return { total: global.size, members: finalMembers.size, missing: [...global.keys()].filter((email) => !finalMembers.has(email)).length, applied: eligible.length, dryRun: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const flags = process.argv.slice(2);
  if (flags.some((flag) => flag !== '--apply' && !flag.startsWith('--consent-file='))) throw new Error('Only --apply and --consent-file=PATH are accepted.');
  const file = flags.find((flag) => flag.startsWith('--consent-file='))?.slice('--consent-file='.length);
  if (flags.includes('--apply') && !file) throw new Error('Apply requires --consent-file=PATH containing a private JSON array of verified opt-in emails.');
  const result = await reconcileGeneral({
    apiKey: process.env.RESEND_API_KEY,
    segmentId: process.env.RESEND_ALL_CONTACTS_SEGMENT_ID,
    apply: flags.includes('--apply'),
    consentEmails: file ? JSON.parse(await readFile(file, 'utf8')) : null,
  });
  console.log(JSON.stringify(result));
}
