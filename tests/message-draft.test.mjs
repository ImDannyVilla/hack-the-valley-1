import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import worker from '../worker.js';
import { MESSAGE_FIELDS, MESSAGE_IMAGE_WIDTH, messageBodyHtml } from '../functions/_shared/message-format.js';
import {
  MESSAGE_IMAGE_MAX_BYTES,
  MessageDraft,
  PENDING_SETTLE_AFTER_MS,
  createResendDraft,
  messageImageKey,
  prepareMessageImage,
} from '../functions/_lib/domain/message-draft.js';
import * as messageEditor from '../public/admin-message-editor.js';
import * as messageDraftComposer from '../public/admin-message-draft.js';
import { onRequestPost, onRequest } from '../functions/api/admin/message-drafts/index.js';
import { onRequestGet as getAudience } from '../functions/api/admin/message-drafts/audience.js';
import { createSponsorshipDb, DEMO_USERS } from './helpers/sponsorship-db.mjs';
import { createFakeResend } from './helpers/fake-resend.mjs';
import { onRequestPost as uploadImage } from '../functions/api/admin/message-drafts/images.js';
import { onRequestGet as getImage } from '../functions/api/email-images/[name].js';

// --- helpers ---------------------------------------------------------------

function mockFetch(responses, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift() || { status: 200, body: {} };
    return new Response(JSON.stringify(next.body || {}), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

// Session + role lookups, plus an in-memory message_draft_receipts table so the
// idempotency path is exercised. Pass a shared `receipts` Map to keep state
// across requests.
function adminDb({ role = 'admin', receipts = new Map() } = {}) {
  const receiptKey = (args) => `${args[0]}::${args[1]}`;
  return {
    receipts,
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() {
          if (/FROM user_sessions/.test(sql)) {
            return { id: 'usr_admin', email: 'admin@example.com', name: 'Admin', session_id: 'ses', session_expires_at: '2099-01-01T00:00:00.000Z' };
          }
          if (/FROM roles/.test(sql)) {
            return role && this.args.includes(role) ? { role, scope_type: 'global', scope_id: '*', created_at: '2026-01-01T00:00:00.000Z' } : null;
          }
          if (/FROM message_draft_receipts/.test(sql)) return receipts.get(receiptKey(this.args)) || null;
          if (/FROM blog_posts/.test(sql)) return null;
          throw new Error(`Unexpected first() query: ${sql}`);
        },
        async run() {
          if (/INSERT INTO message_draft_receipts/.test(sql)) {
            const [actor, key, fingerprint, created_at, updated_at] = this.args;
            if (receipts.has(receiptKey(this.args))) throw new Error('UNIQUE constraint failed: message_draft_receipts');
            receipts.set(receiptKey(this.args), { actor_user_id: actor, idempotency_key: key, fingerprint, status: 'pending', created_at, updated_at });
            return { success: true };
          }
          if (/UPDATE message_draft_receipts/.test(sql)) {
            const [broadcast_id, response_json, updated_at, actor, key] = this.args;
            Object.assign(receipts.get(`${actor}::${key}`), { status: 'created', broadcast_id, response_json, updated_at });
            return { success: true };
          }
          if (/DELETE FROM message_draft_receipts/.test(sql)) {
            receipts.delete(receiptKey(this.args));
            return { success: true };
          }
          throw new Error(`Unexpected run() query: ${sql}`);
        },
        async all() { return { results: [] }; },
      };
    },
  };
}

function draftRequest(body, { cookie, key } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (key) headers['idempotency-key'] = key;
  return new Request('https://hackthevalley.org/api/admin/message-drafts', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const DRAFT_KEY = 'draft-key-0001';
const created = (id) => [{ status: 200, body: { id } }];

// Drafts go to the configured all-contacts segment, and a create names the
// segment the admin was shown.
const AUDIENCE = 'seg_general';
const RESEND_ENV = { RESEND_API_KEY: 'k', RESEND_BROADCAST_FROM: 'HTV <a@b.co>', RESEND_ALL_CONTACTS_SEGMENT_ID: AUDIENCE };
const REF_NAME = (base) => new RegExp(`^${base} · ref [a-f0-9]{12}$`);

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const IMAGE_NAME = 'img_0123456789abcdef.png';

function mockBucket() {
  const objects = new Map();
  const reads = [];
  return {
    objects,
    reads,
    puts: 0,
    async put(key, value, options = {}) {
      this.puts += 1;
      objects.set(key, { bytes: new Uint8Array(value), ...options });
    },
    async head(key) {
      return objects.has(key) ? { key } : null;
    },
    async get(key) {
      reads.push(key);
      const stored = objects.get(key);
      if (!stored) return null;
      return {
        body: stored.bytes,
        httpEtag: '"etag-1"',
        customMetadata: stored.customMetadata,
        writeHttpMetadata(headers) { headers.set('content-type', stored.httpMetadata.contentType); },
      };
    },
  };
}

function imageUploadRequest(bytes, { contentType = 'image/png', cookie } = {}) {
  const headers = { 'content-type': contentType, 'x-filename': 'hack-hours-flyer.png' };
  if (cookie) headers.cookie = cookie;
  return new Request('https://hackthevalley.org/api/admin/message-drafts/images', { method: 'POST', headers, body: bytes });
}

// --- message rendering -----------------------------------------------------

test('messageBodyHtml turns blank lines into paragraphs and line breaks into <br>', () => {
  assert.equal(
    messageBodyHtml('Hello there,\nsecond line\n\n\nNew paragraph'),
    '<p>Hello there,<br>second line</p>\n<p>New paragraph</p>',
  );
});

test('messageBodyHtml renders "- " and "* " lines as bullets, even after a lead-in line', () => {
  assert.equal(
    messageBodyHtml('Details:\n- When: Sat, Nov 7\n* Where: Panera'),
    '<p>Details:</p>\n<ul><li>When: Sat, Nov 7</li><li>Where: Panera</li></ul>',
  );
});

test('messageBodyHtml escapes markup and links http(s) URLs without trailing punctuation', () => {
  const html = messageBodyHtml('Sign up <b>now</b>: https://hackthevalley.org/events/hack-hours/. Food & fun, see https://x.org/a?b=1&c=2');
  assert.match(html, /&lt;b&gt;now&lt;\/b&gt;/);
  assert.match(html, /<a href="https:\/\/hackthevalley\.org\/events\/hack-hours\/">https:\/\/hackthevalley\.org\/events\/hack-hours\/<\/a>\./);
  assert.match(html, /Food &amp; fun/);
  assert.match(html, /<a href="https:\/\/x\.org\/a\?b=1&amp;c=2">/);
});

test('messageBodyHtml never links non-http schemes and keeps Resend personalization tokens', () => {
  const html = messageBodyHtml('Hi {{{contact.first_name|there}}} ({{{contact.email}}}), javascript:alert(1)');
  assert.doesNotMatch(html, /<a /);
  assert.match(html, /\{\{\{contact\.first_name\|there\}\}\}/);
  assert.match(html, /\{\{\{contact\.email\}\}\}/);
});

test('messageBodyHtml renders an "![alt](url)" line as its own image', () => {
  assert.equal(
    messageBodyHtml(`Flyer below:\n![Hack Hours flyer](/api/email-images/${IMAGE_NAME})\nSee you!`),
    `<p>Flyer below:</p>\n<p><img src="/api/email-images/${IMAGE_NAME}" alt="Hack Hours flyer"></p>\n<p>See you!</p>`,
  );
  assert.match(messageBodyHtml('![Logo](https://hackthevalley.org/images/logo.png)'), /<img src="https:\/\/hackthevalley\.org\/images\/logo\.png" alt="Logo">/);
});

test('messageBodyHtml sizes images with {width=N}, clamped to the email body width', () => {
  assert.equal(messageBodyHtml('![Flyer](/a.png){width=360}'), '<p><img src="/a.png" alt="Flyer" width="360"></p>');
  assert.match(messageBodyHtml('![Flyer](/a.png){width=20}'), new RegExp(`width="${MESSAGE_IMAGE_WIDTH.min}"`));
  assert.match(messageBodyHtml('![Flyer](/a.png){width=9999}'), new RegExp(`width="${MESSAGE_IMAGE_WIDTH.max}"`));
});

test('messageBodyHtml renders ## headings, [text](url) links, and **bold**', () => {
  assert.equal(
    messageBodyHtml('## What it does\n### Details\nRead **this** [on the blog](/blog/x) or https://a.org.'),
    '<h2>What it does</h2>\n<h3>Details</h3>\n<p>Read <strong>this</strong> <a href="/blog/x">on the blog</a> or <a href="https://a.org">https://a.org</a>.</p>',
  );
});

test('messageBodyHtml escapes link text and refuses unsafe link targets', () => {
  const html = messageBodyHtml('[<b>x</b>](https://a.org/?q=1&r=2) [bad](javascript:alert(1)) [proto](//evil.example) **<i>y</i>**');
  assert.match(html, /<a href="https:\/\/a\.org\/\?q=1&amp;r=2">&lt;b&gt;x&lt;\/b&gt;<\/a>/);
  assert.match(html, /\[bad\]\(javascript:alert\(1\)\)/);
  assert.match(html, /\[proto\]\(\/\/evil\.example\)/);
  assert.match(html, /<strong>&lt;i&gt;y&lt;\/i&gt;<\/strong>/);
});

test('messageBodyHtml escapes image alt text and refuses non-http image sources', () => {
  assert.match(messageBodyHtml('![a "quote" <b>](https://x.org/a.png)'), /alt="a &quot;quote&quot; &lt;b&gt;"/);
  for (const line of ['![x](data:image/png;base64,AAAA)', '![x](//evil.example/a.png)', '![x](javascript:alert(1))']) {
    assert.doesNotMatch(messageBodyHtml(line), /<img/, line);
  }
});

// --- uploaded images -------------------------------------------------------

const sha16 = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);

test('prepareMessageImage names an image after its content, under email-images/', async () => {
  const name = `img_${await sha16(PNG_BYTES)}.png`;
  assert.deepEqual(await prepareMessageImage({ contentType: 'image/png', bytes: PNG_BYTES }), {
    name,
    key: `email-images/${name}`,
    contentType: 'image/png',
    url: `/api/email-images/${name}`,
  });
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]);
  assert.match((await prepareMessageImage({ contentType: 'image/jpeg', bytes: jpeg })).name, /^img_[a-f0-9]{16}\.jpg$/);
  const other = new Uint8Array([...PNG_BYTES, 9]);
  assert.notEqual((await prepareMessageImage({ contentType: 'image/png', bytes: other })).name, name, 'different content, different name');
});

test('prepareMessageImage rejects other types, mismatched bytes, empty, and oversized files', async () => {
  const cases = [
    { contentType: 'image/webp', bytes: PNG_BYTES },
    { contentType: 'image/svg+xml', bytes: new TextEncoder().encode('<svg/>') },
    { contentType: 'image/png', bytes: new TextEncoder().encode('<html>not an image</html>') },
    { contentType: 'image/png', bytes: new Uint8Array(0) },
    { contentType: 'image/png', bytes: Object.assign(new Uint8Array(MESSAGE_IMAGE_MAX_BYTES + 1), PNG_BYTES) },
  ];
  for (const input of cases) {
    await assert.rejects(prepareMessageImage(input), (error) => error.status === 400, input.contentType);
  }
});

test('messageImageKey only resolves generated image names', () => {
  assert.equal(messageImageKey(IMAGE_NAME), `email-images/${IMAGE_NAME}`);
  for (const name of ['../submissions/x.png', 'email-images/x.png', 'img_123.png', 'img_0123456789abcdef.svg', '', undefined]) {
    assert.equal(messageImageKey(name), null, String(name));
  }
});

test('image upload rejects non-admins and needs the media bucket', async () => {
  const anonymous = await uploadImage({ request: imageUploadRequest(PNG_BYTES), env: { HTV_DB: {}, SUBMISSIONS_MEDIA: mockBucket() } });
  assert.equal(anonymous.status, 401);
  const noBucket = await uploadImage({ request: imageUploadRequest(PNG_BYTES, { cookie: 'htv_session=tok' }), env: { HTV_DB: adminDb() } });
  assert.equal(noBucket.status, 503);
});

test('image upload stores an admin image in R2 and returns its public URL', async () => {
  const bucket = mockBucket();
  const response = await uploadImage({
    request: imageUploadRequest(PNG_BYTES, { cookie: 'htv_session=tok' }),
    env: { HTV_DB: adminDb(), SUBMISSIONS_MEDIA: bucket },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.name, `img_${await sha16(PNG_BYTES)}.png`);
  assert.equal(body.url, `/api/email-images/${body.name}`);
  assert.equal(body.reused, false);
  const stored = bucket.objects.get(`email-images/${body.name}`);
  assert.ok(stored, 'image stored under email-images/');
  assert.deepEqual([...stored.bytes], [...PNG_BYTES]);
  assert.equal(stored.httpMetadata.contentType, 'image/png');
  assert.equal(stored.customMetadata.kind, 'email-image');
  assert.equal(stored.customMetadata.uploadedBy, 'admin@example.com');
});

test('uploading the same image again is idempotent: same URL, no second copy', async () => {
  const bucket = mockBucket();
  const upload = () => uploadImage({
    request: imageUploadRequest(PNG_BYTES, { cookie: 'htv_session=tok' }),
    env: { HTV_DB: adminDb(), SUBMISSIONS_MEDIA: bucket },
  }).then((response) => response.json());
  const first = await upload();
  const second = await upload();
  assert.equal(second.url, first.url);
  assert.equal(second.reused, true);
  assert.equal(bucket.puts, 1);
  assert.equal(bucket.objects.size, 1);
});

test('image upload refuses files that are not PNG/JPEG/GIF', async () => {
  const bucket = mockBucket();
  const response = await uploadImage({
    request: imageUploadRequest(new TextEncoder().encode('<svg onload=alert(1)>'), { contentType: 'image/svg+xml', cookie: 'htv_session=tok' }),
    env: { HTV_DB: adminDb(), SUBMISSIONS_MEDIA: bucket },
  });
  assert.equal(response.status, 400);
  assert.equal(bucket.objects.size, 0);
});

test('public image route serves stored images with long-lived caching', async () => {
  const bucket = mockBucket();
  await bucket.put(`email-images/${IMAGE_NAME}`, PNG_BYTES, { httpMetadata: { contentType: 'image/png' } });
  const response = await getImage({ params: { name: IMAGE_NAME }, env: { SUBMISSIONS_MEDIA: bucket } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...PNG_BYTES]);
});

test('public image route 404s for unknown images and never reads keys outside email-images/', async () => {
  const bucket = mockBucket();
  bucket.objects.set('submissions/private.png', { bytes: PNG_BYTES, httpMetadata: { contentType: 'image/png' } });
  const missing = await getImage({ params: { name: IMAGE_NAME }, env: { SUBMISSIONS_MEDIA: bucket } });
  assert.equal(missing.status, 404);
  const traversal = await getImage({ params: { name: '../submissions/private.png' }, env: { SUBMISSIONS_MEDIA: bucket } });
  assert.equal(traversal.status, 404);
  assert.deepEqual(bucket.reads, [`email-images/${IMAGE_NAME}`]);
});

test('worker routes the image upload and public image endpoints', async () => {
  const bucket = mockBucket();
  await bucket.put(`email-images/${IMAGE_NAME}`, PNG_BYTES, { httpMetadata: { contentType: 'image/png' } });
  const upload = await worker.fetch(imageUploadRequest(PNG_BYTES), { HTV_DB: {}, SUBMISSIONS_MEDIA: bucket });
  assert.equal(upload.status, 401);
  const image = await worker.fetch(new Request(`https://hackthevalley.org/api/email-images/${IMAGE_NAME}`), { SUBMISSIONS_MEDIA: bucket });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
});

test('messageBodyHtml returns an empty string for an empty message', () => {
  assert.equal(messageBodyHtml('  \n\n '), '');
});

// --- route -----------------------------------------------------------------

test('worker routes /api/admin/message-drafts and rejects non-admins with 401', async () => {
  const response = await worker.fetch(draftRequest({ subject: 's', message: 'm' }), { HTV_DB: {} });
  assert.equal(response.status, 401);
});

test('message draft handler rejects non-admins with 401', async () => {
  const response = await onRequestPost({
    request: draftRequest({ subject: 's', message: 'm' }),
    env: { HTV_DB: {} },
  });
  assert.equal(response.status, 401);
});

test('message draft handler requires a subject and a message', async () => {
  for (const body of [{ message: 'm' }, { subject: 's' }, { subject: '   ', message: 'm' }]) {
    const response = await onRequestPost({
      request: draftRequest({ ...body, dryRun: true }, { cookie: 'htv_session=tok' }),
      env: { HTV_DB: adminDb() },
    });
    assert.equal(response.status, 400, JSON.stringify(body));
  }
});

test('message draft handler rejects an over-long subject', async () => {
  const response = await onRequestPost({
    request: draftRequest({ subject: 'x'.repeat(151), message: 'm', dryRun: true }, { cookie: 'htv_session=tok' }),
    env: { HTV_DB: adminDb() },
  });
  assert.equal(response.status, 400);
});

test('message draft dry run renders the blog email chrome without calling Resend', async () => {
  const calls = [];
  const response = await onRequestPost({
    request: draftRequest({ subject: 'Hack Hours is back', message: 'See you Saturday.\n\n- When: 9 AM', dryRun: true }, { cookie: 'htv_session=tok' }),
    env: { HTV_DB: adminDb() },
    fetch: mockFetch([], calls),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.dryRun, true);
  assert.equal(body.subject, 'Hack Hours is back');
  assert.match(body.html, /<h1[^>]*>Hack Hours is back<\/h1>/);
  assert.match(body.html, /<p>See you Saturday\.<\/p>/);
  assert.match(body.html, /<li>When: 9 AM<\/li>/);
  assert.match(body.html, /href="https:\/\/hackthevalley\.org\/events"/);
  assert.match(body.html, /See upcoming events/);
  assert.match(body.html, /\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}/);
  assert.doesNotMatch(body.html, /Read this on the web/);
  assert.equal(calls.length, 0, 'dry run must not hit Resend');
});

test('message draft dry run makes uploaded image URLs absolute and sizes them for email', async () => {
  const response = await onRequestPost({
    request: draftRequest({ subject: 's', message: `![Flyer](/api/email-images/${IMAGE_NAME})`, dryRun: true }, { cookie: 'htv_session=tok' }),
    env: { HTV_DB: adminDb() },
  });
  const body = await response.json();
  assert.match(body.html, new RegExp(`<img style="max-width:100%[^"]*" src="https://hackthevalley\\.org/api/email-images/${IMAGE_NAME}" alt="Flyer">`));
});

const POST_ASSETS = {
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/blog/posts.json') return Response.json({ posts: [{ slug: 'spotlight', title: 'Project Spotlight' }] });
    if (path === '/blog/spotlight') return new Response('<!-- POST:START --><p>Body</p><!-- POST:END -->');
    return new Response('not found', { status: 404 });
  },
};

test('an email started from a blog post links back to the post and is named after it', async () => {
  const preview = await onRequestPost({
    request: draftRequest({ subject: 's', message: 'Read [the post](/blog/spotlight).', postSlug: 'spotlight', dryRun: true }, { cookie: 'htv_session=tok' }),
    env: { HTV_DB: adminDb(), ASSETS: POST_ASSETS },
  });
  const previewBody = await preview.json();
  assert.match(previewBody.html, /<a href="https:\/\/hackthevalley\.org\/blog\/spotlight">the post<\/a>/);
  assert.match(previewBody.html, /Read this on the web: <a href="https:\/\/hackthevalley\.org\/blog\/spotlight"/);

  const calls = [];
  const draft = await onRequestPost({
    request: draftRequest({ subject: 's', message: 'm', postSlug: 'spotlight', segmentId: AUDIENCE }, { cookie: 'htv_session=tok', key: DRAFT_KEY }),
    env: { HTV_DB: adminDb(), ASSETS: POST_ASSETS, ...RESEND_ENV },
    fetch: mockFetch(created('bc_post'), calls),
  });
  assert.equal(draft.status, 200);
  assert.match(JSON.parse(calls[0].init.body).name, REF_NAME('Blog: Project Spotlight'));
});

test('an email for an unknown blog post is refused before anything reaches Resend', async () => {
  const calls = [];
  const response = await onRequestPost({
    request: draftRequest({ subject: 's', message: 'm', postSlug: 'missing' }, { cookie: 'htv_session=tok' }),
    env: { HTV_DB: adminDb(), ASSETS: POST_ASSETS, ...RESEND_ENV },
    fetch: mockFetch([], calls),
  });
  assert.equal(response.status, 404);
  assert.equal(calls.length, 0);
});

test('message draft heading overrides the email title but not the subject', async () => {
  const response = await onRequestPost({
    request: draftRequest({ subject: 'Subject line', heading: 'Big heading', message: 'm', dryRun: true }, { cookie: 'htv_session=tok' }),
    env: { HTV_DB: adminDb() },
  });
  const body = await response.json();
  assert.equal(body.subject, 'Subject line');
  assert.match(body.html, /<h1[^>]*>Big heading<\/h1>/);
});

test('message draft handler creates a Resend draft for an admin and never calls send', async () => {
  const calls = [];
  const response = await onRequestPost({
    request: draftRequest({ subject: 'Hack Hours is back', message: 'See you Saturday.', segmentId: AUDIENCE }, { cookie: 'htv_session=tok', key: DRAFT_KEY }),
    env: { HTV_DB: adminDb(), ...RESEND_ENV },
    fetch: mockFetch(created('bc_quick'), calls),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.broadcastId, 'bc_quick');
  assert.equal(body.status, 'draft');
  assert.equal(body.segmentId, AUDIENCE);
  assert.equal(body.replayed, false);
  assert.equal(calls.length, 1, 'the configured segment is used as is, never looked up by name');
  assert.equal(calls[0].url, 'https://api.resend.com/broadcasts');
  assert.ok(!calls.some((call) => String(call.url).includes('/send')), 'drafts must never call Resend /send');
  const createBody = JSON.parse(calls[0].init.body);
  assert.equal(createBody.segment_id, AUDIENCE);
  assert.equal(createBody.subject, 'Hack Hours is back');
  assert.match(createBody.name, REF_NAME('Email: Hack Hours is back'));
  assert.equal(body.name, createBody.name);
  assert.match(createBody.html, /See you Saturday\./);
  assert.deepEqual(createBody.reply_to, ['contact@hackthevalley.org']);
});

test('a draft is only created for the audience the admin was shown', async () => {
  for (const segmentId of ['seg_old', undefined]) {
    const calls = [];
    const response = await onRequestPost({
      request: draftRequest({ subject: 's', message: 'm', segmentId }, { cookie: 'htv_session=tok', key: DRAFT_KEY }),
      env: { HTV_DB: adminDb(), ...RESEND_ENV },
      fetch: mockFetch(created('bc_x'), calls),
    });
    assert.equal(response.status, 409, String(segmentId));
    assert.match((await response.json()).error, segmentId ? /audience changed/ : /Load the email audience first/);
    assert.equal(calls.length, 0);
  }
});

test('retrying a draft with the same key and content replays it instead of creating a duplicate', async () => {
  const db = adminDb();
  const calls = [];
  const send = () => onRequestPost({
    request: draftRequest({ subject: 'Hack Hours is back', message: 'See you Saturday.', segmentId: AUDIENCE }, { cookie: 'htv_session=tok', key: DRAFT_KEY }),
    env: { HTV_DB: db, ...RESEND_ENV },
    fetch: mockFetch(created('bc_once'), calls),
  }).then((response) => response.json());
  const first = await send();
  const retry = await send();
  assert.equal(first.replayed, false);
  assert.equal(retry.replayed, true);
  assert.equal(retry.broadcastId, 'bc_once');
  assert.equal(calls.filter((call) => call.url === 'https://api.resend.com/broadcasts').length, 1, 'only one Resend draft');
});

test('the same key with different content is refused (409) without touching Resend', async () => {
  const db = adminDb();
  await onRequestPost({
    request: draftRequest({ subject: 's', message: 'first', segmentId: AUDIENCE }, { cookie: 'htv_session=tok', key: DRAFT_KEY }),
    env: { HTV_DB: db, ...RESEND_ENV },
    fetch: mockFetch(created('bc_first')),
  });
  const calls = [];
  const response = await onRequestPost({
    request: draftRequest({ subject: 's', message: 'edited', segmentId: AUDIENCE }, { cookie: 'htv_session=tok', key: DRAFT_KEY }),
    env: { HTV_DB: db, ...RESEND_ENV },
    fetch: mockFetch([], calls),
  });
  assert.equal(response.status, 409);
  assert.equal(calls.length, 0);
});

test('a create Resend refuses (4xx) releases the key so the same request can be retried cleanly', async () => {
  const db = adminDb();
  const request = () => draftRequest({ subject: 's', message: 'm', segmentId: AUDIENCE }, { cookie: 'htv_session=tok', key: DRAFT_KEY });
  const failed = await onRequestPost({
    request: request(),
    env: { HTV_DB: db, ...RESEND_ENV },
    fetch: mockFetch([{ status: 422, body: { message: 'Invalid `from` field.' } }]),
  });
  assert.equal(failed.status, 502);
  assert.equal(db.receipts.size, 0, 'reservation released');
  const retry = await onRequestPost({ request: request(), env: { HTV_DB: db, ...RESEND_ENV }, fetch: mockFetch(created('bc_retry')) });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).broadcastId, 'bc_retry');
});

test('a draft still being created is not created twice (409 while pending)', async () => {
  const db = adminDb();
  const draft = new MessageDraft({ subject: 's', message: 'm' });
  db.receipts.set(`usr_admin::${DRAFT_KEY}`, { fingerprint: await draft.fingerprint(), status: 'pending', created_at: new Date().toISOString() });
  const calls = [];
  await assert.rejects(
    createResendDraft(db, draft, { actorUserId: 'usr_admin', key: DRAFT_KEY, segmentId: AUDIENCE, env: RESEND_ENV, fetcher: mockFetch([], calls) }),
    (error) => error.status === 409 && /still being confirmed/.test(error.message),
  );
  assert.deepEqual(calls.map((call) => call.init.method || 'GET'), ['GET'], 'only looked for it in Resend');
});

test('creating a draft needs a signed-in admin and a valid Idempotency-Key', async () => {
  const draft = new MessageDraft({ subject: 's', message: 'm' });
  await assert.rejects(createResendDraft(adminDb(), draft, { actorUserId: null, key: DRAFT_KEY, env: RESEND_ENV }), (error) => error.status === 403);
  const missing = await onRequestPost({
    request: draftRequest({ subject: 's', message: 'm' }, { cookie: 'htv_session=tok' }),
    env: { HTV_DB: adminDb(), ...RESEND_ENV },
    fetch: mockFetch([]),
  });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /Idempotency-Key/);
});

test('message draft handler returns 503 when Resend is not configured, and reserves nothing', async () => {
  const db = adminDb();
  const response = await onRequestPost({
    request: draftRequest({ subject: 's', message: 'm', segmentId: AUDIENCE }, { cookie: 'htv_session=tok', key: DRAFT_KEY }),
    env: { HTV_DB: db, RESEND_API_KEY: 'k', RESEND_BROADCAST_FROM: 'HTV <a@b.co>' },
    fetch: mockFetch([]),
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /RESEND_ALL_CONTACTS_SEGMENT_ID/);
  assert.equal(db.receipts.size, 0);
});

test('message draft route only accepts POST', async () => {
  const response = await onRequest();
  assert.equal(response.status, 405);
});

// --- the audience: GET /api/admin/message-drafts/audience ----------------------

const audienceRequest = ({ cookie } = {}) => new Request('https://hackthevalley.org/api/admin/message-drafts/audience', { headers: cookie ? { cookie } : {} });

test('the audience route shows admins the configured segment and its current size', async () => {
  const resend = createFakeResend({
    contacts: [{ id: 'c1', unsubscribed: false }, { id: 'c2', unsubscribed: false }, { id: 'c3', unsubscribed: true }],
  });
  assert.equal((await getAudience({ request: audienceRequest(), env: { HTV_DB: {}, ...RESEND_ENV }, fetch: resend.fetch })).status, 401);
  const response = await getAudience({ request: audienceRequest({ cookie: 'htv_session=tok' }), env: { HTV_DB: adminDb(), ...RESEND_ENV }, fetch: resend.fetch });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).audience, { segmentId: AUDIENCE, name: 'General', contactCount: 3, subscribedCount: 2 });
  assert.deepEqual(resend.calls.map((call) => call.path), ['/segments/seg_general', '/segments/seg_general/contacts']);
  assert.equal((await worker.fetch(audienceRequest(), { HTV_DB: {} })).status, 401, 'routed by the worker');
});

test('the audience route reports a missing or unknown segment instead of guessing one', async () => {
  const notConfigured = await getAudience({ request: audienceRequest({ cookie: 'htv_session=tok' }), env: { HTV_DB: adminDb(), RESEND_API_KEY: 'k', RESEND_BROADCAST_FROM: 'HTV <a@b.co>' }, fetch: createFakeResend().fetch });
  assert.equal(notConfigured.status, 503);
  assert.match((await notConfigured.json()).error, /RESEND_ALL_CONTACTS_SEGMENT_ID/);
  const unknown = await getAudience({ request: audienceRequest({ cookie: 'htv_session=tok' }), env: { HTV_DB: adminDb(), ...RESEND_ENV, RESEND_ALL_CONTACTS_SEGMENT_ID: 'seg_gone' }, fetch: createFakeResend().fetch });
  assert.equal(unknown.status, 503);
  assert.match((await unknown.json()).error, /seg_gone/);
});

// --- unknown outcomes, against a real message_draft_receipts table --------------

async function receiptsDb(t) {
  const { db, close } = await createSponsorshipDb();
  t.after(close);
  return db;
}

const ACTOR = DEMO_USERS.alex;
const createDraft = (db, resend, { now } = {}) => createResendDraft(db, new MessageDraft({ subject: 'Hack Hours is back', message: 'See you Saturday.' }), {
  actorUserId: ACTOR, key: DRAFT_KEY, segmentId: AUDIENCE, baseUrl: 'https://hackthevalley.org', env: RESEND_ENV, fetcher: resend.fetch, now,
});
const storedReceipt = (db) => db.prepare('SELECT status, broadcast_id FROM message_draft_receipts WHERE actor_user_id = ? AND idempotency_key = ?').bind(ACTOR, DRAFT_KEY).first();
const createCalls = (resend) => resend.calls.filter((call) => call.method === 'POST').length;

test('a lost success response keeps the key pending, and the retry finds the draft instead of making another', async (t) => {
  const db = await receiptsDb(t);
  const resend = createFakeResend();
  resend.nextCreate = 'lose';
  await assert.rejects(createDraft(db, resend), (error) => error.status === 502 && /didn't confirm the draft/.test(error.message));
  assert.equal(resend.broadcasts.length, 1, 'Resend did create it');
  assert.equal((await storedReceipt(db)).status, 'pending', 'the key is held, not released');

  const retry = await createDraft(db, resend);
  assert.equal(retry.replayed, true);
  assert.equal(retry.broadcastId, resend.broadcasts[0].id);
  assert.equal(createCalls(resend), 1, 'no second create');
  assert.deepEqual(await storedReceipt(db), { status: 'created', broadcast_id: resend.broadcasts[0].id });
});

test('a draft whose id could not be recorded is found on retry, not created again', async (t) => {
  const db = await receiptsDb(t);
  const resend = createFakeResend();
  await db.exec("CREATE TRIGGER fail_receipt BEFORE UPDATE ON message_draft_receipts WHEN NEW.status = 'created' BEGIN SELECT RAISE(ABORT, 'D1 unavailable'); END");
  await assert.rejects(createDraft(db, resend), (error) => error.status === 500 && error.message.includes(resend.broadcasts[0].id));
  assert.equal((await storedReceipt(db)).status, 'pending');
  await db.exec('DROP TRIGGER fail_receipt');

  const retry = await createDraft(db, resend);
  assert.equal(retry.replayed, true);
  assert.equal(retry.broadcastId, resend.broadcasts[0].id);
  assert.equal(createCalls(resend), 1);
  assert.equal((await storedReceipt(db)).status, 'created');
});

test('only a definite rejection releases the key; a 5xx stays pending until Resend shows no draft', async (t) => {
  const db = await receiptsDb(t);
  const resend = createFakeResend();
  resend.nextCreate = 'reject';
  await assert.rejects(createDraft(db, resend), (error) => error.status === 502 && /HTTP 422/.test(error.message));
  assert.equal(await storedReceipt(db), null, 'a 4xx releases the key');

  resend.nextCreate = 'down';
  await assert.rejects(createDraft(db, resend), (error) => error.status === 502 && /didn't confirm the draft/.test(error.message));
  assert.equal((await storedReceipt(db)).status, 'pending', 'a 5xx might still have created it');
  await assert.rejects(createDraft(db, resend), (error) => error.status === 409 && /still being confirmed/.test(error.message));
  assert.equal(createCalls(resend), 2, 'nothing new while it is unsettled');

  const later = new Date(Date.now() + PENDING_SETTLE_AFTER_MS + 1000);
  const settled = await createDraft(db, resend, { now: later });
  assert.equal(settled.replayed, false, 'Resend has no draft for it, so it is created once');
  assert.equal(createCalls(resend), 3);
  assert.equal(resend.broadcasts.length, 1);
  assert.equal((await storedReceipt(db)).broadcast_id, resend.broadcasts[0].id);
});

// --- admin UI --------------------------------------------------------------

const adminHtml = () => readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
const composerJs = () => readFileSync(new URL('../public/admin-message-draft.js', import.meta.url), 'utf8');
const editorJs = () => readFileSync(new URL('../public/admin-message-editor.js', import.meta.url), 'utf8');
// The composer's pure helpers live in two modules: the shared editor and the email composer.
const composer = { ...messageEditor, ...messageDraftComposer };

test('admin page exposes a draft-only message draft composer', () => {
  const html = adminHtml();
  const start = html.indexOf('id="message-draft"');
  const section = html.slice(start, html.indexOf('</section>', start));
  assert.ok(start > 0, 'missing message draft section');
  assert.match(section, /data-admin-section="email"/);
  assert.match(section, /Email draft/);
  assert.match(section, /id="message-draft-start"[^>]*>\s*<option value="">Blank message<\/option>/);
  assert.match(section, /id="message-draft-editor" contenteditable="true"/);
  assert.doesNotMatch(section, /<textarea/);
  assert.match(section, /id="message-draft-create-draft"/);
  assert.match(section, /id="message-draft-audience"/);
  assert.match(section, /id="message-draft-audience-refresh"/);
  assert.match(html, /"message-draft": "email"/);
  assert.match(html, /<script type="module" src="\/admin-message-draft\.js"><\/script>/);
  const js = composerJs();
  assert.match(js, /postJson\('\/api\/admin\/message-drafts'/);
  assert.match(js, /fetch\('\/api\/admin\/message-drafts\/audience'/);
  assert.match(js, /payload\(\{ segmentId: audience\.segmentId \}\)/, 'a create names the audience that was shown');
  assert.match(js, /Nothing will be sent or scheduled from HTV admin/);
  assert.match(js, /'Idempotency-Key': key/);
  for (const source of [section, js]) {
    assert.doesNotMatch(source, /Send now|Schedule send|scheduledAt|sendNow/);
    assert.doesNotMatch(source, /placeholder segment|Recipient placeholder|change recipients/i, 'the audience is real, not a placeholder');
  }
});

test('the composer labels the audience with its size', () => {
  assert.equal(composer.audienceLabel({ name: 'General', contactCount: 1204, subscribedCount: 1180 }), 'General: 1,204 contacts (1,180 subscribed)');
  assert.equal(composer.audienceLabel({ name: 'General', contactCount: 3, subscribedCount: 3 }), 'General: 3 contacts');
  assert.equal(composer.audienceLabel({ name: 'General', contactCount: 1, subscribedCount: 1 }), 'General: 1 contact');
});

test('admin insert buttons are draggable chips for the Resend fields', () => {
  const html = adminHtml();
  const buttons = [...html.matchAll(/<button type="button" draggable="true" data-message-field="([^"]+)"[^>]*class="msg-chip">([^<]+)<\/button>/g)]
    .map((match) => ({ label: match[2], token: match[1] }));
  assert.deepEqual(buttons, MESSAGE_FIELDS.map(({ label, token }) => ({ label, token })));
  assert.match(html, /id="message-draft-image-file" type="file" accept="image\/png,image\/jpeg,image\/gif,image\/webp"/);
  assert.match(editorJs(), /fetch\('\/api\/admin\/message-drafts\/images'/);
  assert.doesNotMatch(html + composerJs() + editorJs(), /FIRST_NAME/, 'use Resend contact.* fields, not legacy FIRST_NAME');
});

// --- admin composer (public/admin-message-draft.js) ------------------------

const textNode = (value) => ({ nodeType: 3, nodeName: '#text', nodeValue: value });
// Like a browser NodeList: iterable with length/item(), but no array methods.
const nodeList = (items) => ({ length: items.length, item: (i) => items[i] ?? null, [Symbol.iterator]: () => items[Symbol.iterator]() });
const element = (nodeName, { dataset = {}, children = [] } = {}) => ({ nodeType: 1, nodeName, dataset, childNodes: nodeList(children) });
const lineBreak = () => element('BR');
const fieldChip = (token, label) => element('SPAN', { dataset: { token }, children: [textNode(label)] });
const imageBlock = (src, alt, width) => element('FIGURE', {
  dataset: { imageSrc: src, imageAlt: alt, imageWidth: String(width) },
  children: [element('IMG'), element('DIV', { children: [element('BUTTON', { children: [textNode('Small')] }), element('INPUT')] })],
});

test('composer constants match the server renderer', () => {
  assert.deepEqual(composer.MESSAGE_FIELDS, MESSAGE_FIELDS);
  assert.deepEqual(composer.IMAGE_WIDTH, MESSAGE_IMAGE_WIDTH);
  for (const size of composer.IMAGE_SIZES) {
    assert.equal(composer.clampImageWidth(size.width), size.width, size.label);
  }
});

test('serializeEditor turns chips, line breaks, and image blocks into the message format', () => {
  const root = element('DIV', { children: [
    textNode('Hi '), fieldChip('{{{contact.first_name|there}}}', 'First name'), textNode('\u200B,'), lineBreak(), lineBreak(),
    textNode('Flyer:'), imageBlock(`/api/email-images/${IMAGE_NAME}`, 'Hack Hours flyer', 360), textNode('\u200BSee\u00A0you there'),
  ] });
  const message = composer.serializeEditor(root);
  assert.equal(message, `Hi {{{contact.first_name|there}}},\n\nFlyer:\n![Hack Hours flyer](/api/email-images/${IMAGE_NAME}){width=360}\nSee you there`);
  // Round trip: the server renders the serialized message as intended.
  const html = messageBodyHtml(message);
  assert.match(html, /<p>Hi \{\{\{contact\.first_name\|there\}\}\},<\/p>/);
  assert.match(html, new RegExp(`<img src="/api/email-images/${IMAGE_NAME}" alt="Hack Hours flyer" width="360">`));
  assert.match(html, /<p>See you there<\/p>/);
});

test('serializeEditor treats block elements as lines and collapses extra blank lines', () => {
  const root = element('DIV', { children: [
    element('DIV', { children: [textNode('Line one')] }),
    element('DIV', { children: [lineBreak()] }),
    element('DIV', { children: [lineBreak()] }),
    element('DIV', { children: [textNode('- bullet')] }),
  ] });
  assert.equal(composer.serializeEditor(root), 'Line one\n\n- bullet');
  assert.equal(composer.serializeEditor(element('DIV', { children: [textNode('\u200B'), lineBreak()] })), '');
});

test('imageLine sanitizes the description and clamps the width', () => {
  assert.equal(composer.imageLine({ src: '/a.png', alt: 'Flyer [v2]\nfinal', width: 9999 }), '![Flyer v2 final](/a.png){width=552}');
  assert.equal(composer.imageLine({ src: '/a.png', alt: '', width: 0 }), '![Image](/a.png)');
  assert.equal(composer.altFromFilename('hack-hours_flyer (1).webp'), 'hack hours flyer 1');
});

test('serializeEditor writes headings, links, and bold with their spacing intact', () => {
  const link = { ...element('A', { children: [textNode(' the post')] }), getAttribute: (name) => (name === 'href' ? '/blog/x' : null) };
  const unsafe = { ...element('A', { children: [textNode('bad')] }), getAttribute: () => 'javascript:alert(1)' };
  const root = element('DIV', { children: [
    element('H2', { children: [textNode('Title')] }),
    textNode('Read'), link, textNode(' and'), element('STRONG', { children: [textNode(' this ')] }), textNode('now '), unsafe,
  ] });
  assert.equal(composer.serializeEditor(root), '## Title\nRead [the post](/blog/x) and **this** now bad');
});

test('htmlToMessage converts a blog post body into the editable message format', () => {
  const a = (href, text) => ({ ...element('A', { children: [textNode(text)] }), getAttribute: (name) => (name === 'href' ? href : null) });
  const img = (src, alt) => ({ ...element('IMG'), getAttribute: (name) => ({ src, alt })[name] ?? null });
  const body = element('DIV', { children: [
    element('P', { children: [textNode('\n  One of the best   parts is '), element('STRONG', { children: [textNode('Continuum')] }), textNode('.\n')] }),
    element('FIGURE', { children: [img('/images/blog/c.png', 'Popup'), element('FIGCAPTION', { children: [textNode('One click to capture.')] })] }),
    element('H2', { children: [textNode('Try it out')] }),
    element('UL', { children: [
      element('LI', { children: [a('https://chromewebstore.google.com/x', 'Chrome Web Store')] }),
      element('LI', { children: [a('javascript:alert(1)', 'Not a link')] }),
    ] }),
    element('SCRIPT', { children: [textNode('alert(1)')] }),
  ] });
  assert.equal(composer.htmlToMessage(body), [
    'One of the best parts is **Continuum**.',
    '![Popup](/images/blog/c.png)',
    'One click to capture.',
    '## Try it out',
    '- [Chrome Web Store](https://chromewebstore.google.com/x)\n- Not a link',
  ].join('\n\n'));
});

test('htmlToMessage keeps image widths from posts published in admin', () => {
  const img = { ...element('IMG'), getAttribute: (name) => ({ src: '/api/email-images/img_0123456789abcdef.png', alt: 'Shot', width: '360' })[name] ?? null };
  assert.equal(composer.htmlToMessage(element('DIV', { children: [element('P', { children: [img] })] })), '![Shot](/api/email-images/img_0123456789abcdef.png){width=360}');
});

test('messageBlocks and inlineParts rebuild editor content from message text', () => {
  const blocks = composer.messageBlocks('## Hi {{{contact.first_name|there}}}\n\nRead [this](/blog/x), **now**!\n![Flyer](/a.png){width=300}');
  assert.deepEqual(blocks, [
    { type: 'heading', level: 2, parts: [{ type: 'text', value: 'Hi ' }, { type: 'field', label: 'First name', token: '{{{contact.first_name|there}}}' }] },
    { type: 'blank' },
    { type: 'line', parts: [
      { type: 'text', value: 'Read ' }, { type: 'link', text: 'this', href: '/blog/x' }, { type: 'text', value: ', ' },
      { type: 'bold', text: 'now' }, { type: 'text', value: '!' },
    ] },
    { type: 'image', alt: 'Flyer', src: '/a.png', width: 300 },
  ]);
  assert.deepEqual(composer.inlineParts('{{{contact.unknown}}} {{{contact.email}}}'), [
    { type: 'text', value: '{{{contact.unknown}}} ' },
    { type: 'field', label: 'Email', token: '{{{contact.email}}}' },
  ]);
});

test('previewWithSampleContact fills fields like a real inbox but leaves other tokens alone', () => {
  const html = composer.previewWithSampleContact('<p>Hi {{{contact.first_name|there}}} {{{contact.last_name}}} ({{{contact.email}}}), {{{contact.company|friend}}}</p><a href="{{{RESEND_UNSUBSCRIBE_URL}}}">x</a>');
  assert.equal(html, '<p>Hi Alex Rivera (alex.rivera@example.com), friend</p><a href="{{{RESEND_UNSUBSCRIBE_URL}}}">x</a>');
  assert.equal(composer.previewWithSampleContact('{{{contact.first_name}}}', { first_name: '<b>' }), '&lt;b&gt;');
});
