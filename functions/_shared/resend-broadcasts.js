// Resend broadcasts adapter: the only code that talks to Resend's Broadcast
// and Email APIs for admin email. It creates broadcasts, either as drafts or
// sent as they are created (`send: true`, only after an admin confirms in the
// composer), and emails one address for an admin's test. It never schedules.
// Callers (the MessageDraft domain object) hand it an already-rendered email.
//
// Every broadcast is addressed to HTV's updates audience, the Resend segment in
// RESEND_ALL_CONTACTS_SEGMENT_ID (General). Its contacts are real recipients,
// so there is no fallback to another segment, and fetchDraftAudience gives its
// name and current size for the admin to check before sending or drafting.
//
// History: blog blasts used to be scheduled and sent through here and logged
// in the blog_broadcast_sends table (migration 0025), with a daily cron
// reconciling those rows against Resend. That path was removed once admin
// became draft-only. The table and its rows are left in place as history;
// dropping them would be a separate, approved migration.

export const DRAFT_STATUS = 'draft';
// Resend's status for a broadcast it is delivering.
export const SENDING_STATUS = 'queued';

// How long a create waits for Resend. Giving up leaves the outcome unknown
// (Resend may still create the draft), so it is never treated as a refusal.
export const CREATE_TIMEOUT_MS = 15000;

// The longest broadcast name Resend accepts. A longer one is refused with
// 422 "Field `name` has a maximum of 70 items"; Resend's docs don't list it.
export const BROADCAST_NAME_MAX = 70;

function httpError(message, status, extra) {
  return Object.assign(new Error(message), { status }, extra || {});
}

async function readResponseText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

// Resolve the draft settings from env. Throws a 503 (not configured) if a
// required value is missing, matching how the mailing-list sync behaves.
// Drafts carry a reply-to address because the email template asks recipients
// to reply with projects/stories to feature on the blog.
export function resolveBroadcastConfig(env = {}) {
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  // RESEND_BROADCAST_FROM only — no fallback to RESEND_FROM/RESEND_FROM_EMAIL. Those are the
  // transactional (login) sender; silently reusing one for whole-list blasts would let production
  // look configured with a sender never verified for broadcast, contradicting the deploy gate
  // this function exists to enforce (see htv-issue-100).
  const from = String(env.RESEND_BROADCAST_FROM || '').trim();
  const replyTo = String(env.RESEND_BROADCAST_REPLY_TO || env.RESEND_REPLY_TO || env.HTV_CONTACT_EMAIL || 'contact@hackthevalley.org').trim();
  // The audience every draft is addressed to. No name-based guess: a guessed
  // segment could be the wrong list of real people.
  const segmentId = String(env.RESEND_ALL_CONTACTS_SEGMENT_ID || '').trim();
  const missing = [];
  if (!apiKey) missing.push('RESEND_API_KEY');
  if (!from) missing.push('RESEND_BROADCAST_FROM');
  if (!segmentId) missing.push('RESEND_ALL_CONTACTS_SEGMENT_ID');
  if (missing.length) {
    throw httpError(`Admin email is not configured. Missing: ${missing.join(', ')}.`, 503);
  }
  return { apiKey, from, replyTo, segmentId };
}

// Every item in a Resend list. The first request sets no limit, which makes
// Resend return the whole list at once (one request against its rate limit);
// pages are followed only if it still reports more.
async function fetchResendList({ apiKey, fetcher, path }) {
  const items = [];
  let after = '';
  for (let page = 0; page < 50; page += 1) {
    const url = new URL(path, 'https://api.resend.com');
    if (after) {
      url.searchParams.set('limit', '100');
      url.searchParams.set('after', after);
    }
    const response = await fetcher(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      throw httpError(`Could not inspect Resend list ${path} (HTTP ${response.status}).`, 502);
    }
    const payload = await response.json().catch(() => ({}));
    const data = payload?.data || payload?.contacts || payload?.segments || [];
    if (Array.isArray(data)) items.push(...data);
    if (!payload?.has_more || !Array.isArray(data) || data.length === 0) break;
    after = data[data.length - 1]?.id;
    if (!after) break;
  }
  return items;
}

// Who a new draft is addressed to: the configured segment's name, how many
// contacts it has now, and how many of them are subscribed (a sent broadcast
// skips the unsubscribed ones). Read-only.
export async function fetchDraftAudience({ env = {}, fetcher = fetch } = {}) {
  const { apiKey, segmentId } = resolveBroadcastConfig(env);
  const path = `/segments/${encodeURIComponent(segmentId)}`;
  const response = await fetcher(`https://api.resend.com${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (response.status === 404) {
    throw httpError(`RESEND_ALL_CONTACTS_SEGMENT_ID names a segment that Resend doesn't have (${segmentId}).`, 503);
  }
  if (!response.ok) {
    throw httpError(`Could not load the Resend segment (HTTP ${response.status}).`, 502);
  }
  const segment = await response.json().catch(() => ({}));
  const contacts = await fetchResendList({ apiKey, fetcher, path: `${path}/contacts` });
  return {
    segmentId,
    name: String(segment?.name || '').trim() || segmentId,
    contactCount: contacts.length,
    subscribedCount: contacts.filter((contact) => !contact?.unsubscribed).length,
  };
}

// Create a broadcast to the configured audience and return its id: a draft,
// or with `send` one that Resend sends as it creates it, in this one request,
// so there is no separate send step that could fail or repeat on its own. A
// failure says whether the broadcast may exist (and, with `send`, be going
// out) anyway:
//   created: false  Resend answered 4xx: it refused, so nothing was created;
//   created: null   no answer (network error or timeout), a 5xx, or a success
//                   without an id: Resend may have created it.
// Only the first is safe to retry without checking Resend.
export async function createBroadcast({ config, fetcher = fetch, subject, name, html, send = false, timeoutMs = CREATE_TIMEOUT_MS } = {}) {
  const body = { segment_id: config.segmentId, from: config.from, subject, name, html };
  if (config.replyTo) body.reply_to = [config.replyTo];
  if (send) body.send = true;
  let response;
  try {
    response = await fetcher('https://api.resend.com/broadcasts', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw httpError(`Resend did not answer (${error?.message || error}).`, 502, { created: null });
  }
  if (!response.ok) {
    throw httpError(`Resend broadcast create failed with HTTP ${response.status}: ${await readResponseText(response)}`, 502, {
      created: response.status < 500 ? false : null,
    });
  }
  const created = await response.json().catch(() => ({}));
  const broadcastId = created?.id || created?.data?.id;
  if (!broadcastId) {
    throw httpError('Resend accepted the draft but returned no id.', 502, { created: null });
  }
  return broadcastId;
}

// Email one address through Resend's Email API (not a broadcast), for an
// admin's test of a draft. Resend fills no contact fields here, so the caller
// fills them in first. Returns Resend's email id.
export async function sendEmail({ config, fetcher = fetch, to, subject, html } = {}) {
  const body = { from: config.from, to: [to], subject, html };
  if (config.replyTo) body.reply_to = [config.replyTo];
  const response = await fetcher('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw httpError(`Resend email send failed with HTTP ${response.status}: ${await readResponseText(response)}`, 502);
  }
  const sent = await response.json().catch(() => ({}));
  return sent?.id || null;
}

// The broadcast whose name contains `marker`, or null. Callers put a unique
// reference in each broadcast's name, so a create whose outcome is unknown can
// be looked up afterwards.
export async function findBroadcast({ config, fetcher = fetch, marker } = {}) {
  const broadcasts = await fetchResendList({ apiKey: config.apiKey, fetcher, path: '/broadcasts' });
  const match = broadcasts.find((broadcast) => broadcast?.id && String(broadcast.name || '').includes(marker));
  if (!match) return null;
  return {
    broadcastId: match.id,
    name: match.name,
    segmentId: match.segment_id || match.audience_id || null,
    status: match.status || null,
  };
}
