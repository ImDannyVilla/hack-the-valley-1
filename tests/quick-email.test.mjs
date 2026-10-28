import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import worker from '../worker.js';
import {
  EMAIL_IMAGE_MAX_BYTES,
  QUICK_EMAIL_FIELDS,
  emailImageKey,
  prepareEmailImageUpload,
  quickEmailBodyHtml,
} from '../functions/_shared/quick-email.js';
import { createDraftEmail } from '../functions/_lib/domain/blog-broadcast.js';
import { onRequestPost, onRequest } from '../functions/api/admin/quick-email.js';
import { onRequestPost as uploadImage } from '../functions/api/admin/quick-email/images.js';
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

// Session + role lookups only; quick emails never touch the send-log table.
function adminDb({ role = 'admin' } = {}) {
  return {
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
          throw new Error(`Unexpected first() query: ${sql}`);
        },
        async run() { throw new Error(`Unexpected run() query: ${sql}`); },
        async all() { return { results: [] }; },
      };
    },
  };
}

function quickEmailRequest(body, { cookie } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  return new Request('https://hackthevalley.org/api/admin/quick-email', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

const RESEND_ENV = { RESEND_API_KEY: 'k', RESEND_BROADCAST_FROM: 'HTV <a@b.co>' };

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const IMAGE_NAME = 'img_0123456789abcdef.png';

function mockBucket() {
  const objects = new Map();
  const reads = [];
  return {
    objects,
    reads,
    async put(key, value, options = {}) {
      objects.set(key, { bytes: new Uint8Array(value), ...options });
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
  return new Request('https://hackthevalley.org/api/admin/quick-email/images', { method: 'POST', headers, body: bytes });
}

// --- message rendering -----------------------------------------------------

test('quickEmailBodyHtml turns blank lines into paragraphs and line breaks into <br>', () => {
  assert.equal(
    quickEmailBodyHtml('Hello there,\nsecond line\n\n\nNew paragraph'),
    '<p>Hello there,<br>second line</p>\n<p>New paragraph</p>',
  );
});

test('quickEmailBodyHtml renders "- " and "* " lines as bullets, even after a lead-in line', () => {
  assert.equal(
    quickEmailBodyHtml('Details:\n- When: Sat, Nov 7\n* Where: Panera'),
    '<p>Details:</p>\n<ul><li>When: Sat, Nov 7</li><li>Where: Panera</li></ul>',
  );
});

test('quickEmailBodyHtml escapes markup and links http(s) URLs without trailing punctuation', () => {
  const html = quickEmailBodyHtml('Sign up <b>now</b>: https://hackthevalley.org/events/hack-hours/. Food & fun, see https://x.org/a?b=1&c=2');
  assert.match(html, /&lt;b&gt;now&lt;\/b&gt;/);
  assert.match(html, /<a href="https:\/\/hackthevalley\.org\/events\/hack-hours\/">https:\/\/hackthevalley\.org\/events\/hack-hours\/<\/a>\./);
  assert.match(html, /Food &amp; fun/);
  assert.match(html, /<a href="https:\/\/x\.org\/a\?b=1&amp;c=2">/);
});

test('quickEmailBodyHtml never links non-http schemes and keeps Resend personalization tokens', () => {
  const html = quickEmailBodyHtml('Hi {{{contact.first_name|there}}} ({{{contact.email}}}), javascript:alert(1)');
  assert.doesNotMatch(html, /<a /);
  assert.match(html, /\{\{\{contact\.first_name\|there\}\}\}/);
  assert.match(html, /\{\{\{contact\.email\}\}\}/);
});

test('quickEmailBodyHtml renders an "![alt](url)" line as its own image', () => {
  assert.equal(
    quickEmailBodyHtml(`Flyer below:\n![Hack Hours flyer](/api/email-images/${IMAGE_NAME})\nSee you!`),
    `<p>Flyer below:</p>\n<p><img src="/api/email-images/${IMAGE_NAME}" alt="Hack Hours flyer"></p>\n<p>See you!</p>`,
  );
  assert.match(quickEmailBodyHtml('![Logo](https://hackthevalley.org/images/logo.png)'), /<img src="https:\/\/hackthevalley\.org\/images\/logo\.png" alt="Logo">/);
});

test('quickEmailBodyHtml escapes image alt text and refuses non-http image sources', () => {
  assert.match(quickEmailBodyHtml('![a "quote" <b>](https://x.org/a.png)'), /alt="a &quot;quote&quot; &lt;b&gt;"/);
  for (const line of ['![x](data:image/png;base64,AAAA)', '![x](//evil.example/a.png)', '![x](javascript:alert(1))']) {
    assert.doesNotMatch(quickEmailBodyHtml(line), /<img/, line);
  }
});

// --- uploaded images -------------------------------------------------------

test('prepareEmailImageUpload names PNG/JPEG/GIF uploads under email-images/', () => {
  const upload = prepareEmailImageUpload({ contentType: 'image/png', bytes: PNG_BYTES, id: 'img_0123456789abcdef' });
  assert.deepEqual(upload, {
    name: IMAGE_NAME,
    key: `email-images/${IMAGE_NAME}`,
    contentType: 'image/png',
    url: `/api/email-images/${IMAGE_NAME}`,
  });
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]);
  assert.equal(prepareEmailImageUpload({ contentType: 'image/jpeg', bytes: jpeg, id: 'img_0123456789abcdef' }).name, 'img_0123456789abcdef.jpg');
});

test('prepareEmailImageUpload rejects other types, mismatched bytes, empty, and oversized files', () => {
  const cases = [
    { contentType: 'image/webp', bytes: PNG_BYTES },
    { contentType: 'image/svg+xml', bytes: new TextEncoder().encode('<svg/>') },
    { contentType: 'image/png', bytes: new TextEncoder().encode('<html>not an image</html>') },
    { contentType: 'image/png', bytes: new Uint8Array(0) },
    { contentType: 'image/png', bytes: Object.assign(new Uint8Array(EMAIL_IMAGE_MAX_BYTES + 1), PNG_BYTES) },
  ];
  for (const input of cases) {
    assert.throws(() => prepareEmailImageUpload({ ...input, id: 'img_0123456789abcdef' }), (error) => error.status === 400, input.contentType);
  }
});

test('emailImageKey only resolves generated image names', () => {
  assert.equal(emailImageKey(IMAGE_NAME), `email-images/${IMAGE_NAME}`);
  for (const name of ['../submissions/x.png', 'email-images/x.png', 'img_123.png', 'img_0123456789abcdef.svg', '', undefined]) {
    assert.equal(emailImageKey(name), null, String(name));
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
  assert.match(body.url, /^\/api\/email-images\/img_[a-f0-9]{16}\.png$/);
  const stored = bucket.objects.get(`email-images/${body.name}`);
  assert.ok(stored, 'image stored under email-images/');
  assert.deepEqual([...stored.bytes], [...PNG_BYTES]);
  assert.equal(stored.httpMetadata.contentType, 'image/png');
  assert.equal(stored.customMetadata.kind, 'email-image');
  assert.equal(stored.customMetadata.uploadedBy, 'admin@example.com');
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

test('quickEmailBodyHtml returns an empty string for an empty message', () => {
  assert.equal(quickEmailBodyHtml('  \n\n '), '');
});

// --- domain ----------------------------------------------------------------

test('createDraftEmail creates a Resend draft without a post slug and never calls send', async () => {
  const calls = [];
  const result = await createDraftEmail({
    subject: 's', name: 'Quick email: s', html: '<p>e</p>',
    env: RESEND_ENV,
    fetcher: mockFetch([
      { status: 200, body: { data: [{ id: 'seg_general', name: 'General' }] } },
      { status: 200, body: { id: 'bc_quick' } },
    ], calls),
  });
  assert.equal(result.broadcastId, 'bc_quick');
  assert.equal(result.status, 'draft');
  assert.equal('slug' in result, false);
  assert.ok(!calls.some((call) => String(call.url).includes('/send')));
});

// --- route -----------------------------------------------------------------

test('worker routes /api/admin/quick-email and rejects non-admins with 401', async () => {
  const response = await worker.fetch(quickEmailRequest({ subject: 's', message: 'm' }), { HTV_DB: {} });
  assert.equal(response.status, 401);
});

test('quick email handler rejects non-admins with 401', async () => {
  const response = await onRequestPost({
    request: quickEmailRequest({ subject: 's', message: 'm' }),
    env: { HTV_DB: {} },
  });
  assert.equal(response.status, 401);
});

test('quick email handler requires a subject and a message', async () => {
  for (const body of [{ message: 'm' }, { subject: 's' }, { subject: '   ', message: 'm' }]) {
    const response = await onRequestPost({
      request: quickEmailRequest({ ...body, dryRun: true }, { cookie: 'htv_session=tok' }),
      env: { HTV_DB: adminDb() },
    });
    assert.equal(response.status, 400, JSON.stringify(body));
  }
});

test('quick email handler rejects an over-long subject', async () => {
  const response = await onRequestPost({
    request: quickEmailRequest({ subject: 'x'.repeat(151), message: 'm', dryRun: true }, { cookie: 'htv_session=tok' }),
    env: { HTV_DB: adminDb() },
  });
  assert.equal(response.status, 400);
});

test('quick email dry run renders the blog email chrome without calling Resend', async () => {
  const calls = [];
  const response = await onRequestPost({
    request: quickEmailRequest({ subject: 'Hack Hours is back', message: 'See you Saturday.\n\n- When: 9 AM', dryRun: true }, { cookie: 'htv_session=tok' }),
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

test('quick email dry run makes uploaded image URLs absolute and sizes them for email', async () => {
  const response = await onRequestPost({
    request: quickEmailRequest({ subject: 's', message: `![Flyer](/api/email-images/${IMAGE_NAME})`, dryRun: true }, { cookie: 'htv_session=tok' }),
    env: { HTV_DB: adminDb() },
  });
  const body = await response.json();
  assert.match(body.html, new RegExp(`<img style="max-width:100%[^"]*" src="https://hackthevalley\\.org/api/email-images/${IMAGE_NAME}" alt="Flyer">`));
});

test('quick email heading overrides the email title but not the subject', async () => {
  const response = await onRequestPost({
    request: quickEmailRequest({ subject: 'Subject line', heading: 'Big heading', message: 'm', dryRun: true }, { cookie: 'htv_session=tok' }),
    env: { HTV_DB: adminDb() },
  });
  const body = await response.json();
  assert.equal(body.subject, 'Subject line');
  assert.match(body.html, /<h1[^>]*>Big heading<\/h1>/);
});

test('quick email handler creates a Resend draft for an admin and never calls send', async () => {
  const calls = [];
  const response = await onRequestPost({
    request: quickEmailRequest({ subject: 'Hack Hours is back', message: 'See you Saturday.' }, { cookie: 'htv_session=tok' }),
    env: { HTV_DB: adminDb(), ...RESEND_ENV },
    fetch: mockFetch([
      { status: 200, body: { data: [{ id: 'seg_general', name: 'General' }] } },
      { status: 200, body: { id: 'bc_quick' } },
    ], calls),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.broadcastId, 'bc_quick');
  assert.equal(body.status, 'draft');
  assert.equal(body.scheduled, false);
  assert.equal(body.needsRecipientReview, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://api.resend.com/broadcasts');
  assert.ok(!calls.some((call) => String(call.url).includes('/send')), 'quick email must never call Resend /send');
  const createBody = JSON.parse(calls[1].init.body);
  assert.equal(createBody.subject, 'Hack Hours is back');
  assert.equal(createBody.name, 'Quick email: Hack Hours is back');
  assert.match(createBody.html, /See you Saturday\./);
  assert.deepEqual(createBody.reply_to, ['contact@hackthevalley.org']);
});

test('quick email handler returns 503 when Resend is not configured', async () => {
  const response = await onRequestPost({
    request: quickEmailRequest({ subject: 's', message: 'm' }, { cookie: 'htv_session=tok' }),
    env: { HTV_DB: adminDb() },
    fetch: mockFetch([]),
  });
  assert.equal(response.status, 503);
});

test('quick email route only accepts POST', async () => {
  const response = await onRequest();
  assert.equal(response.status, 405);
});

// --- admin UI --------------------------------------------------------------

test('admin page exposes draft-only quick email controls', () => {
  const html = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
  const start = html.indexOf('id="quick-email"');
  const section = html.slice(start, html.indexOf('</section>', start));
  assert.ok(start > 0, 'missing quick email section');
  assert.match(section, /data-admin-section="blog"/);
  assert.match(section, /Quick email draft/);
  assert.match(section, /id="quick-email-create-draft"/);
  assert.match(html, /api\("\/api\/admin\/quick-email"/);
  assert.match(html, /"quick-email": "blog"/);
  assert.doesNotMatch(section, /Send now|Schedule send|type="date"|type="time"/);
});

test('admin quick email insert buttons use the same Resend fields as the renderer docs', () => {
  const html = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
  const tokens = [...html.matchAll(/data-quick-email-insert="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tokens, QUICK_EMAIL_FIELDS.map((field) => field.token));
  assert.match(html, /id="quick-email-image-file" type="file" accept="image\/png,image\/jpeg,image\/gif,image\/webp"/);
  assert.match(html, /fetch\("\/api\/admin\/quick-email\/images"/);
  assert.doesNotMatch(html, /FIRST_NAME/, 'use Resend contact.* fields, not legacy FIRST_NAME');
});
