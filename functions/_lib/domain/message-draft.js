// MessageDraft domain object: the one home for "an admin email draft", the
// editable message an organizer prepares before anything is sent (see
// MessageDraft in docs/domain-model.md). It owns the draft's rules: a required
// subject and message within limits, the optional blog post (a ContentItem) it
// was started from and links back to, how it renders as an email, the images
// it may carry, and how it reaches Resend at most once per request, addressed
// to the audience the admin was shown: as a Resend draft, or sent.
//
// Sending is approval-gated (docs/domain-model.md): the composer sends only
// after the signed-in admin types SEND to confirm the audience and count, and
// every send is audited. A test email goes only to the admin. Nothing here
// schedules. Pure formatting lives in functions/_shared/message-format.js and
// functions/_shared/email-template.js; Resend calls live in
// functions/_shared/resend-broadcasts.js.

import { absolutizeUrls, buildEmailHtml } from '../../_shared/email-template.js';
import { MESSAGE_LIMITS, fillContactFields, messageBodyHtml } from '../../_shared/message-format.js';
import {
  BROADCAST_NAME_MAX,
  DRAFT_STATUS,
  SENDING_STATUS,
  createBroadcast,
  findBroadcast,
  resolveBroadcastConfig,
  sendEmail,
} from '../../_shared/resend-broadcasts.js';
import { auditEventStatement, buildAuditEvent } from './audit.js';
import { loadBlogPost } from './blog-post.js';

function draftError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function text(value, label, max, { required = false } = {}) {
  const trimmed = String(value || '').trim();
  if (required && !trimmed) throw draftError(`${label} is required.`);
  if (trimmed.length > max) throw draftError(`${label} must be ${max} characters or fewer.`);
  return trimmed;
}

async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class MessageDraft {
  constructor({ subject, heading = '', message, post = null } = {}) {
    this.subject = subject;
    this.heading = heading;
    this.message = message;
    this.post = post;
  }

  // Validate organizer input. A postSlug must name a published post (file-based
  // or published from admin).
  static async fromInput(input = {}, { assets, origin, db = null } = {}) {
    const subject = text(input.subject, 'Subject', MESSAGE_LIMITS.subject, { required: true });
    const heading = text(input.heading, 'Heading', MESSAGE_LIMITS.heading);
    const message = text(input.message, 'Message', MESSAGE_LIMITS.message, { required: true });
    const postSlug = text(input.postSlug, 'Post', 200);
    const post = postSlug ? await loadBlogPost(assets, postSlug, { origin, db }) : null;
    return new MessageDraft({ subject, heading, message, post });
  }

  get title() {
    return this.heading || this.subject;
  }

  // The email HTML. Uploaded images and post links are root-relative
  // (/api/email-images/..., /blog/...); email clients need absolute URLs.
  toEmailHtml({ baseUrl } = {}) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    return buildEmailHtml({
      title: this.title,
      contentHtml: absolutizeUrls(messageBodyHtml(this.message), base),
      postUrl: this.post ? this.post.webUrl(base) : undefined,
      eventsUrl: `${base}/events`,
    });
  }

  // Resend broadcast name (internal label, not shown to recipients).
  broadcastName() {
    return this.post ? this.post.broadcastName() : `Email: ${this.subject}`;
  }

  // Identity of the draft's content, so a retried request can be matched to
  // the original one.
  fingerprint() {
    return sha256Hex(JSON.stringify([this.subject, this.heading, this.message, this.post?.slug || null]));
  }
}

// --- handing a draft to Resend, once per request -----------------------------

// The composer sends one Idempotency-Key per request content (the same
// pattern as sponsorship writes); the same content keeps the same key.
const REQUEST_KEY = /^[\w.:-]{8,150}$/;

// How long a create with an unknown outcome stays pending before HTV may
// conclude from Resend's broadcast list that it never happened. Far longer
// than a create can run (CREATE_TIMEOUT_MS), so that attempt is over.
export const PENDING_SETTLE_AFTER_MS = 5 * 60 * 1000;

// Create the Resend draft for a MessageDraft at most once per (admin, key).
// Nothing is sent: the admin reviews, schedules, or sends it in Resend.
export function createResendDraft(db, draft, options = {}) {
  return handOff(db, draft, { ...options, send: false });
}

// Send a MessageDraft to the audience now, at most once per (admin, key). This
// is the approval-gated step: the composer calls it only after the admin types
// SEND to confirm the audience and count. Resend sends the broadcast as it
// creates it, so this is the same hand-off as a draft and a retry never sends
// again. Each send is recorded with a message_draft.send audit event, in the
// same batch as its receipt.
export function sendMessageDraft(db, draft, options = {}) {
  return handOff(db, draft, { ...options, send: true });
}

// Resend can't deduplicate broadcast creates, so the key is reserved
// ('pending') in message_draft_receipts (migration 0031), the broadcast is
// created with the reservation's reference in its name, and the result is
// recorded ('created'). A retry with the same key and content replays the
// recorded broadcast; the same key with different content (or a draft's key
// reused for a send) is refused.
//
// Only a definite rejection from Resend (a 4xx) releases the key. Any other
// failure (no answer, a 5xx, a lost response, or failing to record the
// returned id) leaves it pending, and the next attempt settles it before
// anything is created: a broadcast carrying the reference in Resend is
// recorded and replayed; if there is none once PENDING_SETTLE_AFTER_MS has
// passed, the key is released and the broadcast created.
//
// `segmentId` is the audience the admin was shown. It must still be the
// configured one, so nothing goes to a list the admin didn't check.
async function handOff(db, draft, { actorUserId, key, segmentId, baseUrl, env = {}, fetcher = fetch, now = new Date(), send }) {
  if (!actorUserId) throw draftError(`A signed-in admin is required to ${send ? 'send emails' : 'create drafts'}.`, 403);
  if (typeof key !== 'string' || !REQUEST_KEY.test(key)) throw draftError('A valid Idempotency-Key is required.');
  const config = resolveBroadcastConfig(env);
  const content = await draft.fingerprint();
  const receipt = {
    actorUserId,
    key,
    send,
    draft,
    fingerprint: send ? await sha256Hex(`send\n${content}`) : content,
    ref: `ref ${(await sha256Hex(`${actorUserId}\n${key}`)).slice(0, 12)}`,
  };

  const settled = await settledReceipt(db, receipt, { config, fetcher, now });
  if (settled) return settled;
  if (segmentId !== config.segmentId) {
    throw draftError(segmentId
      ? 'The email audience changed after this page loaded it. Refresh it, check who it goes to, then try again.'
      : 'Load the email audience first, so you can check who it goes to.', 409);
  }

  const name = nameWithRef(draft.broadcastName(), receipt.ref);
  const html = draft.toEmailHtml({ baseUrl });
  const reservedAt = now.toISOString();
  try {
    await db
      .prepare(
        `INSERT INTO message_draft_receipts (actor_user_id, idempotency_key, fingerprint, status, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?)`
      )
      .bind(actorUserId, key, receipt.fingerprint, reservedAt, reservedAt)
      .run();
  } catch (error) {
    // A concurrent request with the same key reserved it first.
    const concurrent = await settledReceipt(db, receipt, { config, fetcher, now });
    if (concurrent) return concurrent;
    throw error;
  }

  let broadcastId;
  try {
    broadcastId = await createBroadcast({ config, fetcher, subject: draft.subject, name, html, send });
  } catch (error) {
    if (error.created === false) {
      await releaseReceipt(db, receipt, reservedAt);
      throw error;
    }
    throw draftError(send
      ? `Resend didn't confirm the send (${error.message}). HTV is holding it so it can't go out twice: Resend may already be sending "${name}". Check Resend's broadcasts; trying again in a few minutes records it, or sends it if it never went out.`
      : `Resend didn't confirm the draft (${error.message}). HTV is holding it so it can't be created twice: it may already be in Resend as "${name}". Trying again in a few minutes records it, or creates it if it isn't there.`,
    502);
  }

  const result = { broadcastId, name, segmentId: config.segmentId, status: send ? SENDING_STATUS : DRAFT_STATUS };
  try {
    await recordResult(db, receipt, result, new Date());
  } catch {
    throw draftError(send
      ? `Resend is sending "${name}" (broadcast ${broadcastId}), but HTV couldn't record it. Don't send it again; trying again later records it.`
      : `Resend created the draft "${name}" (broadcast ${broadcastId}), but HTV couldn't record it. It's in Resend, so don't create it again; trying again later records it.`,
    500);
  }
  return { ...result, replayed: false };
}

function findReceipt(db, receipt) {
  return db
    .prepare('SELECT fingerprint, status, response_json, created_at FROM message_draft_receipts WHERE actor_user_id = ? AND idempotency_key = ?')
    .bind(receipt.actorUserId, receipt.key)
    .first();
}

// What Resend already made for this key (a replay), or null when the key is
// free to use. Throws if the key was used for different content, or if an
// earlier attempt's outcome can't be settled yet.
async function settledReceipt(db, receipt, { config, fetcher, now }) {
  const row = await findReceipt(db, receipt);
  if (!row) return null;
  if (row.fingerprint !== receipt.fingerprint) {
    throw draftError('This request key was already used for a different message. Start a new draft.', 409);
  }
  if (row.status === 'created') return { ...JSON.parse(row.response_json), replayed: true };

  // Pending: an earlier attempt is still running, or ended without knowing
  // whether Resend created the broadcast. Resend's broadcast list settles it.
  let found;
  try {
    found = await findBroadcast({ config, fetcher, marker: receipt.ref });
  } catch (error) {
    throw draftError(`HTV couldn't check Resend for this email (${error.message}). Try again in a minute; nothing will go out twice.`, 503);
  }
  if (found) {
    const status = found.status || (receipt.send ? SENDING_STATUS : DRAFT_STATUS);
    const result = { broadcastId: found.broadcastId, name: found.name, segmentId: found.segmentId, status };
    await recordResult(db, receipt, result, now);
    return { ...result, replayed: true };
  }
  const age = now.getTime() - Date.parse(row.created_at);
  if (!(age >= PENDING_SETTLE_AFTER_MS)) {
    throw draftError("This email is still being confirmed with Resend. Check Resend, or try again in a few minutes; nothing will go out twice.", 409);
  }
  await releaseReceipt(db, receipt, row.created_at);
  return null;
}

// The broadcast name: the draft's label, shortened if the whole name would
// pass Resend's limit, then the reference. The reference is kept whole because
// it is how an unconfirmed create is found again.
function nameWithRef(label, ref) {
  const suffix = ` · ${ref}`;
  const room = BROADCAST_NAME_MAX - suffix.length;
  if (label.length <= room) return `${label}${suffix}`;
  const chars = Array.from(label);
  while (chars.join('').length > room - 1) chars.pop();
  return `${chars.join('').trimEnd()}…${suffix}`;
}

// Record what Resend made for this key. A send is recorded together with its
// audit event, in one batch, so neither is stored without the other. The
// event's id comes from the request: if a racing attempt recorded the send
// first, this batch fails on that id, and the send is already recorded.
async function recordResult(db, receipt, result, at) {
  const update = db
    .prepare(
      `UPDATE message_draft_receipts SET status = 'created', broadcast_id = ?, response_json = ?, updated_at = ?
       WHERE actor_user_id = ? AND idempotency_key = ? AND status = 'pending'`
    )
    .bind(result.broadcastId, JSON.stringify(result), at.toISOString(), receipt.actorUserId, receipt.key);
  if (!receipt.send) {
    await update.run();
    return;
  }
  const audit = {
    ...buildAuditEvent({
      action: 'message_draft.send',
      actorUserId: receipt.actorUserId,
      targetType: 'resend_broadcast',
      targetId: result.broadcastId,
      scopeType: 'global',
      scopeId: '*',
      metadata: { subject: receipt.draft.subject, name: result.name, segmentId: result.segmentId, postSlug: receipt.draft.post?.slug || null },
      createdAt: at.toISOString(),
    }),
    id: `audit_${(await sha256Hex(`message_draft.send\n${receipt.actorUserId}\n${receipt.key}`)).slice(0, 32)}`,
  };
  try {
    await db.batch([auditEventStatement(db, audit), update]);
  } catch (error) {
    if ((await findReceipt(db, receipt))?.status === 'created') return;
    throw error;
  }
}

// Free the key, but only the reservation this attempt knows about: a newer
// one belongs to another attempt.
function releaseReceipt(db, receipt, reservedAt) {
  return db
    .prepare(
      `DELETE FROM message_draft_receipts
       WHERE actor_user_id = ? AND idempotency_key = ? AND status = 'pending' AND created_at = ?`
    )
    .bind(receipt.actorUserId, receipt.key, reservedAt)
    .run();
}

// --- a test email to yourself ------------------------------------------------

// Email this draft to the signed-in admin only, to check it in a real inbox
// before sending. Resend fills contact fields only in broadcasts, so they are
// filled here from the admin's own account. Nothing goes to the audience, and
// a test is not a send: it isn't audited or deduplicated.
export async function sendTestEmail(draft, { to, name = '', baseUrl, env = {}, fetcher = fetch } = {}) {
  const address = String(to || '').trim();
  if (!address) throw draftError('Your account has no email address to send the test to.', 400);
  const config = resolveBroadcastConfig(env);
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const [firstName = '', ...lastName] = String(name || '').trim().split(/\s+/);
  const html = fillContactFields(
    draft.toEmailHtml({ baseUrl: base }),
    { first_name: firstName, last_name: lastName.join(' '), email: address },
    { unsubscribeUrl: `${base}/` },
  );
  const emailId = await sendEmail({ config, fetcher, to: address, subject: `[Test] ${draft.subject}`, html });
  return { to: address, emailId };
}

// --- images ----------------------------------------------------------------
//
// Email clients fetch images over plain public URLs, so uploads live in R2
// under email-images/ and are served by /api/email-images/<name>, which only
// resolves names matching MESSAGE_IMAGE_NAME (never other bucket objects).
// Names come from the image's content (SHA-256), so uploading the same image
// again resolves to the same file: uploads are idempotent and never duplicate.
// Files are not deleted when removed from a draft, because emails that were
// already sent keep pointing at them. Only email-safe formats are accepted;
// the composer converts other images (e.g. WebP) to JPEG before upload.

export const MESSAGE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const MESSAGE_IMAGE_TYPES = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' });
const MESSAGE_IMAGE_NAME = /^img_[a-f0-9]{16}\.(png|jpg|gif)$/;

export async function prepareMessageImage({ contentType, bytes } = {}) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  const ext = MESSAGE_IMAGE_TYPES[type];
  if (!ext) throw draftError('Images must be PNG, JPEG, or GIF.');
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || new ArrayBuffer(0));
  if (!data.byteLength) throw draftError('The image file is empty.');
  if (data.byteLength > MESSAGE_IMAGE_MAX_BYTES) {
    throw draftError(`Images must be ${MESSAGE_IMAGE_MAX_BYTES / 1024 / 1024}MB or smaller.`);
  }
  if (sniffImageType(data) !== type) throw draftError('The file contents are not a valid PNG, JPEG, or GIF image.');
  const name = `img_${(await sha256Hex(data)).slice(0, 16)}.${ext}`;
  return { name, key: messageImageKey(name), contentType: type, url: `/api/email-images/${name}` };
}

// The R2 key for a public image name, or null for anything else.
export function messageImageKey(name) {
  return MESSAGE_IMAGE_NAME.test(String(name || '')) ? `email-images/${name}` : null;
}

function sniffImageType(data) {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return 'image/gif';
  return null;
}
