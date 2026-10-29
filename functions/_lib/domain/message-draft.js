// MessageDraft domain object: the one home for "an admin email draft", the
// editable message an organizer prepares before anything is sent (see
// MessageDraft in docs/domain-model.md). It owns the draft's rules: a required
// subject and message within limits, the optional blog post (a ContentItem) it
// was started from and links back to, how it renders as an email, the images
// it may carry, and how it becomes a Resend draft at most once per request.
//
// Sending stays a human step in Resend: nothing here calls Resend's send or
// schedule endpoints. Pure formatting lives in functions/_shared/message-format.js
// and functions/_shared/email-template.js; Resend calls live in
// functions/_shared/resend-broadcasts.js.

import { absolutizeUrls, buildEmailHtml } from '../../_shared/email-template.js';
import { MESSAGE_LIMITS, messageBodyHtml } from '../../_shared/message-format.js';
import { createDraftEmail } from '../../_shared/resend-broadcasts.js';
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

// --- creating the Resend draft, once per request ----------------------------

// The composer sends one Idempotency-Key per draft attempt (the same pattern
// as sponsorship writes); the same content keeps the same key.
const REQUEST_KEY = /^[\w.:-]{8,150}$/;

// Create the Resend draft for a MessageDraft at most once per (admin, key).
// Creating a draft is an external side effect, so the key is reserved first
// ('pending'), the draft is created, then the result is recorded ('created')
// in message_draft_receipts (migration 0031). A retry with the same key and
// content replays the recorded draft; the same key with different content is
// refused. If Resend refuses the create, the reservation is released so a
// clean retry is possible.
export async function createResendDraft(db, draft, { actorUserId, key, baseUrl, env = {}, fetcher = fetch } = {}) {
  if (!actorUserId) throw draftError('A signed-in admin is required to create drafts.', 403);
  if (typeof key !== 'string' || !REQUEST_KEY.test(key)) throw draftError('A valid Idempotency-Key is required.');
  const fingerprint = await draft.fingerprint();

  const recorded = await recordedDraft(db, { actorUserId, key, fingerprint });
  if (recorded) return recorded;

  const reservedAt = new Date().toISOString();
  try {
    await db
      .prepare(
        `INSERT INTO message_draft_receipts (actor_user_id, idempotency_key, fingerprint, status, created_at, updated_at)
         VALUES (?, ?, ?, 'pending', ?, ?)`
      )
      .bind(actorUserId, key, fingerprint, reservedAt, reservedAt)
      .run();
  } catch (error) {
    // A concurrent request with the same key reserved it first.
    const concurrent = await recordedDraft(db, { actorUserId, key, fingerprint });
    if (concurrent) return concurrent;
    throw error;
  }

  let result;
  try {
    result = await createDraftEmail({
      subject: draft.subject,
      name: draft.broadcastName(),
      html: draft.toEmailHtml({ baseUrl }),
      env,
      fetcher,
    });
  } catch (error) {
    await db
      .prepare('DELETE FROM message_draft_receipts WHERE actor_user_id = ? AND idempotency_key = ?')
      .bind(actorUserId, key)
      .run();
    throw error;
  }

  await db
    .prepare(
      `UPDATE message_draft_receipts SET status = 'created', broadcast_id = ?, response_json = ?, updated_at = ?
       WHERE actor_user_id = ? AND idempotency_key = ?`
    )
    .bind(result.broadcastId, JSON.stringify(result), new Date().toISOString(), actorUserId, key)
    .run();
  return { ...result, replayed: false };
}

// The recorded draft for this key (a replay), or null for a new key. Throws if
// the key was used for different content or its draft is still being created.
async function recordedDraft(db, { actorUserId, key, fingerprint }) {
  const row = await db
    .prepare('SELECT fingerprint, status, response_json FROM message_draft_receipts WHERE actor_user_id = ? AND idempotency_key = ?')
    .bind(actorUserId, key)
    .first();
  if (!row) return null;
  if (row.fingerprint !== fingerprint) {
    throw draftError('This request key was already used for a different message. Start a new draft.', 409);
  }
  if (row.status !== 'created') {
    throw draftError('This draft is still being created. Wait a moment, then check Resend before trying again.', 409);
  }
  return { ...JSON.parse(row.response_json), replayed: true };
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
