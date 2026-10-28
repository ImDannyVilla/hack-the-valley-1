import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import worker from '../worker.js';
import {
  EMAIL_IMAGE_MAX_BYTES,
  EMAIL_IMAGE_WIDTH,
  QUICK_EMAIL_FIELDS,
  emailImageKey,
  prepareEmailImageUpload,
  quickEmailBodyHtml,
} from '../functions/_shared/quick-email.js';
import * as composer from '../public/admin-quick-email.js';
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

test('quickEmailBodyHtml sizes images with {width=N}, clamped to the email body width', () => {
  assert.equal(quickEmailBodyHtml('![Flyer](/a.png){width=360}'), '<p><img src="/a.png" alt="Flyer" width="360"></p>');
  assert.match(quickEmailBodyHtml('![Flyer](/a.png){width=20}'), new RegExp(`width="${EMAIL_IMAGE_WIDTH.min}"`));
  assert.match(quickEmailBodyHtml('![Flyer](/a.png){width=9999}'), new RegExp(`width="${EMAIL_IMAGE_WIDTH.max}"`));
});

test('quickEmailBodyHtml renders ## headings, [text](url) links, and **bold**', () => {
  assert.equal(
    quickEmailBodyHtml('## What it does\n### Details\nRead **this** [on the blog](/blog/x) or https://a.org.'),
    '<h2>What it does</h2>\n<h3>Details</h3>\n<p>Read <strong>this</strong> <a href="/blog/x">on the blog</a> or <a href="https://a.org">https://a.org</a>.</p>',
  );
});

test('quickEmailBodyHtml escapes link text and refuses unsafe link targets', () => {
  const html = quickEmailBodyHtml('[<b>x</b>](https://a.org/?q=1&r=2) [bad](javascript:alert(1)) [proto](//evil.example) **<i>y</i>**');
  assert.match(html, /<a href="https:\/\/a\.org\/\?q=1&amp;r=2">&lt;b&gt;x&lt;\/b&gt;<\/a>/);
  assert.match(html, /\[bad\]\(javascript:alert\(1\)\)/);
  assert.match(html, /\[proto\]\(\/\/evil\.example\)/);
  assert.match(html, /<strong>&lt;i&gt;y&lt;\/i&gt;<\/strong>/);
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
    request: quickEmailRequest({ subject: 's', message: 'Read [the post](/blog/spotlight).', postSlug: 'spotlight', dryRun: true }, { cookie: 'htv_session=tok' }),
    env: { HTV_DB: adminDb(), ASSETS: POST_ASSETS },
  });
  const previewBody = await preview.json();
  assert.match(previewBody.html, /<a href="https:\/\/hackthevalley\.org\/blog\/spotlight">the post<\/a>/);
  assert.match(previewBody.html, /Read this on the web: <a href="https:\/\/hackthevalley\.org\/blog\/spotlight"/);

  const calls = [];
  const draft = await onRequestPost({
    request: quickEmailRequest({ subject: 's', message: 'm', postSlug: 'spotlight' }, { cookie: 'htv_session=tok' }),
    env: { HTV_DB: adminDb(), ASSETS: POST_ASSETS, ...RESEND_ENV },
    fetch: mockFetch([
      { status: 200, body: { data: [{ id: 'seg_general', name: 'General' }] } },
      { status: 200, body: { id: 'bc_post' } },
    ], calls),
  });
  assert.equal(draft.status, 200);
  assert.equal(JSON.parse(calls[1].init.body).name, 'Blog: Project Spotlight');
});

test('an email for an unknown blog post is refused before anything reaches Resend', async () => {
  const calls = [];
  const response = await onRequestPost({
    request: quickEmailRequest({ subject: 's', message: 'm', postSlug: 'missing' }, { cookie: 'htv_session=tok' }),
    env: { HTV_DB: adminDb(), ASSETS: POST_ASSETS, ...RESEND_ENV },
    fetch: mockFetch([], calls),
  });
  assert.equal(response.status, 404);
  assert.equal(calls.length, 0);
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

const adminHtml = () => readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
const composerJs = () => readFileSync(new URL('../public/admin-quick-email.js', import.meta.url), 'utf8');

test('admin page exposes a draft-only quick email composer', () => {
  const html = adminHtml();
  const start = html.indexOf('id="quick-email"');
  const section = html.slice(start, html.indexOf('</section>', start));
  assert.ok(start > 0, 'missing quick email section');
  assert.match(section, /data-admin-section="blog"/);
  assert.match(section, /Email draft/);
  assert.match(section, /id="quick-email-start"[^>]*>\s*<option value="">Blank message<\/option>/);
  assert.match(section, /id="quick-email-editor" contenteditable="true"/);
  assert.doesNotMatch(section, /<textarea/);
  assert.match(section, /id="quick-email-create-draft"/);
  assert.match(html, /"quick-email": "blog"/);
  assert.match(html, /<script type="module" src="\/admin-quick-email\.js"><\/script>/);
  const js = composerJs();
  assert.match(js, /postJson\('\/api\/admin\/quick-email'/);
  assert.match(js, /Nothing will be sent or scheduled from HTV admin/);
  for (const source of [section, js]) {
    assert.doesNotMatch(source, /Send now|Schedule send|scheduledAt|sendNow/);
  }
});

test('admin insert buttons are draggable chips for the Resend fields', () => {
  const html = adminHtml();
  const buttons = [...html.matchAll(/<button type="button" draggable="true" data-quick-email-insert="([^"]+)"[^>]*class="qe-chip">([^<]+)<\/button>/g)]
    .map((match) => ({ label: match[2], token: match[1] }));
  assert.deepEqual(buttons, QUICK_EMAIL_FIELDS.map(({ label, token }) => ({ label, token })));
  assert.match(html, /id="quick-email-image-file" type="file" accept="image\/png,image\/jpeg,image\/gif,image\/webp"/);
  assert.match(composerJs(), /fetch\('\/api\/admin\/quick-email\/images'/);
  assert.doesNotMatch(html + composerJs(), /FIRST_NAME/, 'use Resend contact.* fields, not legacy FIRST_NAME');
});

// --- admin composer (public/admin-quick-email.js) --------------------------

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
  assert.deepEqual(composer.QUICK_EMAIL_FIELDS, QUICK_EMAIL_FIELDS);
  assert.deepEqual(composer.IMAGE_WIDTH, EMAIL_IMAGE_WIDTH);
  for (const size of composer.IMAGE_SIZES) {
    assert.equal(composer.clampImageWidth(size.width), size.width, size.label);
  }
});

test('serializeEditor turns chips, line breaks, and image blocks into the message format', () => {
  const root = element('DIV', { children: [
    textNode('Hi '), fieldChip('{{{contact.first_name|there}}}', 'First name'), textNode('​,'), lineBreak(), lineBreak(),
    textNode('Flyer:'), imageBlock(`/api/email-images/${IMAGE_NAME}`, 'Hack Hours flyer', 360), textNode('​See you there'),
  ] });
  const message = composer.serializeEditor(root);
  assert.equal(message, `Hi {{{contact.first_name|there}}},\n\nFlyer:\n![Hack Hours flyer](/api/email-images/${IMAGE_NAME}){width=360}\nSee you there`);
  // Round trip: the server renders the serialized message as intended.
  const html = quickEmailBodyHtml(message);
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
  assert.equal(composer.serializeEditor(element('DIV', { children: [textNode('​'), lineBreak()] })), '');
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
