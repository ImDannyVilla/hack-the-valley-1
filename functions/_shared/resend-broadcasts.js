// Resend broadcasts adapter: the only code that talks to Resend's Broadcast
// API. It creates draft broadcasts and never calls Resend's send or schedule
// endpoints; organizers review recipients and send from Resend. Callers (the
// MessageDraft domain object) hand it an already-rendered email.
//
// History: blog blasts used to be scheduled and sent through here and logged
// in the blog_broadcast_sends table (migration 0025), with a daily cron
// reconciling those rows against Resend. That path was removed once admin
// became draft-only. The table and its rows are left in place as history;
// dropping them would be a separate, approved migration.

export const DRAFT_STATUS = 'draft';

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

// Resolve the broadcast settings from env. Throws a 503 (not configured) if a
// required value is missing, matching how the mailing-list sync behaves.
// Broadcasts carry a reply-to address because the email template asks
// recipients to reply with projects/stories to feature on the blog.
export function resolveBroadcastConfig(env = {}) {
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  // RESEND_BROADCAST_FROM only — no fallback to RESEND_FROM/RESEND_FROM_EMAIL. Those are the
  // transactional (login) sender; silently reusing one for whole-list blasts would let production
  // look configured with a sender never verified for broadcast, contradicting the deploy gate
  // this function exists to enforce (see htv-issue-100).
  const from = String(env.RESEND_BROADCAST_FROM || '').trim();
  const replyTo = String(env.RESEND_BROADCAST_REPLY_TO || env.RESEND_REPLY_TO || env.HTV_CONTACT_EMAIL || 'contact@hackthevalley.org').trim();
  const missing = [];
  if (!apiKey) missing.push('RESEND_API_KEY');
  if (!from) missing.push('RESEND_BROADCAST_FROM');
  if (missing.length) {
    throw httpError(`Email blasts are not configured. Missing: ${missing.join(', ')}.`, 503);
  }
  return { apiKey, from, replyTo };
}

function isDraftPlaceholderSegment(segment) {
  const name = String(segment?.name || '').trim().toLowerCase();
  const id = String(segment?.id || '').trim().toLowerCase();
  return ['general', 'draft', 'drafts', 'preview', 'test'].includes(name) || ['general', 'draft', 'drafts', 'preview', 'test'].includes(id);
}

async function fetchResendList({ apiKey, fetcher, path }) {
  const items = [];
  let after = '';
  for (let page = 0; page < 50; page += 1) {
    const url = new URL(path, 'https://api.resend.com');
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);
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

// Resend's API requires segment_id even when creating a draft. For draft-only
// workflows, do NOT verify or create an all-contacts segment. Use an explicitly
// configured safe placeholder, or auto-pick an existing placeholder-like segment
// such as "General". The operator must review/change recipients inside Resend
// before sending.
export async function resolveDraftSegmentId({ env = {}, fetcher = fetch } = {}) {
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  const explicit = String(
    env.RESEND_BROADCAST_DRAFT_SEGMENT_ID ||
      env.RESEND_DRAFT_SEGMENT_ID ||
      ''
  ).trim();
  if (explicit) {
    return { segmentId: explicit, segmentName: null, source: 'configured' };
  }

  const segments = await fetchResendList({ apiKey, fetcher, path: '/segments' });
  const candidates = segments.filter((segment) => segment?.id && isDraftPlaceholderSegment(segment));
  if (candidates.length === 1) {
    return { segmentId: candidates[0].id, segmentName: candidates[0].name || null, source: 'auto-discovered-placeholder' };
  }

  const names = segments.map((segment) => segment.name || segment.id).filter(Boolean).join(', ') || 'none';
  throw httpError(
    `Resend requires segment_id even to create a draft broadcast. Set RESEND_BROADCAST_DRAFT_SEGMENT_ID to an existing safe placeholder segment. Available segments: ${names}.`,
    409,
  );
}

// Create a Resend broadcast (a draft targeting the segment) and return its id.
export async function createBroadcast({ env = {}, fetcher = fetch, audienceId, from, replyTo, subject, name, html } = {}) {
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  const body = { segment_id: audienceId, from, subject, name, html };
  if (replyTo) body.reply_to = [replyTo];
  const response = await fetcher('https://api.resend.com/broadcasts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw httpError(`Resend broadcast create failed with HTTP ${response.status}: ${await readResponseText(response)}`, 502);
  }
  const created = await response.json().catch(() => ({}));
  const broadcastId = created?.id || created?.data?.id;
  if (!broadcastId) {
    throw httpError('Resend broadcast create returned no id.', 502);
  }
  return broadcastId;
}

// Create a Resend draft of an already-rendered email. This intentionally does
// not call /send, because no mail has been accepted for delivery.
export async function createDraftEmail({ subject, name, html, env = {}, fetcher = fetch } = {}) {
  const { from, replyTo } = resolveBroadcastConfig(env);
  const draftSegment = await resolveDraftSegmentId({ env, fetcher });
  const broadcastId = await createBroadcast({
    env,
    fetcher,
    audienceId: draftSegment.segmentId,
    from,
    replyTo,
    subject,
    name,
    html,
  });
  return {
    broadcastId,
    status: DRAFT_STATUS,
    scheduled: false,
    segmentId: draftSegment.segmentId,
    segmentName: draftSegment.segmentName,
    segmentSource: draftSegment.source,
    needsRecipientReview: true,
    warning: 'Created a Resend draft only. No send or schedule call was made; review/change recipients in Resend before sending.',
  };
}
