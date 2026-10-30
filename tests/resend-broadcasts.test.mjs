// Email template, the Resend draft adapter, loading blog posts for message
// drafts, and the blog post file contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  absolutizeUrls,
  buildEmailHtml,
} from '../functions/_shared/email-template.js';
import { BlogPost } from '../functions/_lib/domain/blog-post.js';
import {
  createBroadcast,
  fetchDraftAudience,
  findBroadcast,
  resolveBroadcastConfig,
  sendEmail,
} from '../functions/_shared/resend-broadcasts.js';
import { onRequestGet as getPost, onRequest as postRouteFallback } from '../functions/api/admin/message-drafts/blog-post.js';
import { createFakeResend } from './helpers/fake-resend.mjs';

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

function mockAssets(files) {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      const body = files[url.pathname];
      if (body === undefined) return new Response('not found', { status: 404 });
      const isJson = url.pathname.endsWith('.json');
      return new Response(body, {
        status: 200,
        headers: { 'content-type': isJson ? 'application/json' : 'text/html; charset=utf-8' },
      });
    },
  };
}

// Session + role lookups only (mirrors the role-aware mock in event-platform.test.mjs).
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
          if (/FROM blog_posts/.test(sql)) return null;
          throw new Error(`Unexpected first() query: ${sql}`);
        },
        async run() { throw new Error(`Unexpected run() query: ${sql}`); },
        async all() { return { results: [] }; },
      };
    },
  };
}

const POST_HTML = [
  '<html><head><title>Test Post</title></head><body>',
  '<!-- POST:START -->',
  '<div class="post-body"><p>Hello world.</p><img src="/images/blog/x.png" alt="x"></div>',
  '<!-- POST:END -->',
  '<aside>CTA chrome we do not want in the email body</aside>',
  '</body></html>',
].join('\n');

const MANIFEST = JSON.stringify({ posts: [{ slug: 'test-post', title: 'Test Post', excerpt: 'hi' }] });

function assets(files = { '/blog/posts.json': MANIFEST, '/blog/test-post': POST_HTML }) {
  return mockAssets(files);
}

function postRequest(slug, { cookie } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  return new Request(`https://hackthevalley.org/api/admin/message-drafts/blog-post?slug=${encodeURIComponent(slug)}`, { headers });
}

// --- pure helpers + Resend draft path --------------------------------------

test('BlogPost.body returns the content between the markers (mechanism stays hidden)', () => {
  const content = new BlogPost({ slug: 'test-post', rawHtml: POST_HTML }).body();
  assert.match(content, /Hello world/);
  assert.doesNotMatch(content, /CTA chrome/);
  assert.doesNotMatch(content, /<title>/);
});

test('BlogPost.body throws 422 when the post has no body markers', () => {
  assert.throws(() => new BlogPost({ slug: 'x', rawHtml: '<p>no markers</p>' }).body(), (err) => err.status === 422);
});

test('absolutizeUrls rewrites root-relative URLs and leaves absolute ones', () => {
  const out = absolutizeUrls('<img src="/images/x.png"><a href="https://x.com">e</a><img src="//cdn/y">', 'https://hackthevalley.org');
  assert.match(out, /src="https:\/\/hackthevalley\.org\/images\/x\.png"/);
  assert.match(out, /href="https:\/\/x\.com"/);
  assert.match(out, /src="\/\/cdn\/y"/);
});

test('buildEmailHtml includes title, upcoming-events CTA, submission CTA, and unsubscribe token', () => {
  const html = buildEmailHtml({
    title: 'My Post',
    contentHtml: '<p>body</p>',
    postUrl: 'https://hackthevalley.org/blog/my-post',
    eventsUrl: 'https://hackthevalley.org/events',
  });
  assert.match(html, /My Post/);
  assert.match(html, /<p>body<\/p>/);
  assert.match(html, /See upcoming events/);
  assert.match(html, /href="https:\/\/hackthevalley\.org\/events"/);
  assert.match(html, /Want to highlight something on the Hack the Valley blog\? Reply to this email/);
  assert.match(html, /\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}/);
});

test('buildEmailHtml constrains image width inline so screenshots do not overflow', () => {
  const html = buildEmailHtml({
    title: 'P',
    contentHtml: '<figure><img src="https://h.org/images/big.png" alt="x"><figcaption>cap</figcaption></figure>',
  });
  // the <img> must get an inline max-width (email clients ignore <style>)
  assert.match(html, /<img style="[^"]*max-width:100%[^"]*"\s+src="https:\/\/h\.org\/images\/big\.png"/);
  assert.match(html, /<figcaption style="[^"]*text-align:center/);
});

const SEGMENT = { RESEND_ALL_CONTACTS_SEGMENT_ID: 'seg_general' };
const CONFIG = { apiKey: 'k', from: 'HTV <a@b.co>', replyTo: 'contact@hackthevalley.org', segmentId: 'seg_general' };

test('resolveBroadcastConfig requires an API key, sender, and the all-contacts segment', () => {
  assert.throws(() => resolveBroadcastConfig({}), (err) => {
    return err.status === 503 && /RESEND_API_KEY/.test(err.message) && /RESEND_BROADCAST_FROM/.test(err.message) && /RESEND_ALL_CONTACTS_SEGMENT_ID/.test(err.message);
  });
  const config = resolveBroadcastConfig({ RESEND_API_KEY: 'k', RESEND_BROADCAST_FROM: 'HTV <a@b.co>', ...SEGMENT });
  assert.equal(config.from, 'HTV <a@b.co>');
  assert.equal(config.replyTo, 'contact@hackthevalley.org');
  assert.equal(config.segmentId, 'seg_general');
  const custom = resolveBroadcastConfig({ RESEND_API_KEY: 'k', RESEND_BROADCAST_FROM: 'HTV <a@b.co>', RESEND_BROADCAST_REPLY_TO: 'blog@hackthevalley.org', ...SEGMENT });
  assert.equal(custom.replyTo, 'blog@hackthevalley.org');
});

test('drafts never pick a segment by name: only RESEND_ALL_CONTACTS_SEGMENT_ID is used', () => {
  // The old draft placeholder settings (and a segment that happens to be named
  // General) are not a fallback: General has real recipients.
  for (const env of [{ RESEND_BROADCAST_DRAFT_SEGMENT_ID: 'seg_general' }, { RESEND_DRAFT_SEGMENT_ID: 'seg_general' }, {}]) {
    assert.throws(() => resolveBroadcastConfig({ RESEND_API_KEY: 'k', RESEND_BROADCAST_FROM: 'HTV <a@b.co>', ...env }), (err) => {
      return err.status === 503 && /Missing: RESEND_ALL_CONTACTS_SEGMENT_ID/.test(err.message);
    });
  }
  const code = readFileSync(new URL('../functions/_shared/resend-broadcasts.js', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /placeholder|DRAFT_SEGMENT_ID|'general'/i);
});

test('resolveBroadcastConfig does not fall back to RESEND_FROM / RESEND_FROM_EMAIL (htv-issue-100)', () => {
  // RESEND_FROM/RESEND_FROM_EMAIL are the transactional (login) sender. Accepting either as a
  // broadcast fallback would let production look configured for whole-list blasts using a
  // sender never verified for that purpose - the exact footgun PR #45 intended to close.
  assert.throws(() => resolveBroadcastConfig({ RESEND_API_KEY: 'k', RESEND_FROM: 'legacy@b.co' }), (err) => {
    return err.status === 503 && /RESEND_BROADCAST_FROM/.test(err.message);
  });
  assert.throws(() => resolveBroadcastConfig({ RESEND_API_KEY: 'k', RESEND_FROM_EMAIL: 'legacy@b.co' }), (err) => {
    return err.status === 503 && /RESEND_BROADCAST_FROM/.test(err.message);
  });
  assert.throws(() => resolveBroadcastConfig({ RESEND_API_KEY: 'k', RESEND_FROM: 'a@b.co', RESEND_FROM_EMAIL: 'c@d.co' }), (err) => {
    return err.status === 503 && /RESEND_BROADCAST_FROM/.test(err.message);
  });
  // RESEND_BROADCAST_FROM set alongside the legacy vars still wins - and uses the broadcast
  // value, not either legacy one, confirming there's no silent cross-contamination either way.
  const config = resolveBroadcastConfig({
    RESEND_API_KEY: 'k', RESEND_BROADCAST_FROM: 'HTV <a@b.co>',
    RESEND_FROM: 'legacy@b.co', RESEND_FROM_EMAIL: 'also-legacy@b.co', ...SEGMENT,
  });
  assert.equal(config.from, 'HTV <a@b.co>');
});

test('fetchDraftAudience counts the segment in one request and follows pages if Resend reports more', async () => {
  const calls = [];
  const fetcher = mockFetch([
    { status: 200, body: { object: 'segment', id: 'seg_general', name: 'General' } },
    { status: 200, body: { has_more: true, data: [{ id: 'c1' }, { id: 'c2', unsubscribed: true }] } },
    { status: 200, body: { has_more: false, data: [{ id: 'c3', unsubscribed: false }] } },
  ], calls);
  const audience = await fetchDraftAudience({ env: { RESEND_API_KEY: 'k', RESEND_BROADCAST_FROM: 'f', ...SEGMENT }, fetcher });
  assert.deepEqual(audience, { segmentId: 'seg_general', name: 'General', contactCount: 3, subscribedCount: 2 });
  assert.deepEqual(calls.map((call) => call.url), [
    'https://api.resend.com/segments/seg_general',
    'https://api.resend.com/segments/seg_general/contacts',
    'https://api.resend.com/segments/seg_general/contacts?limit=100&after=c2',
  ]);
});

test('createBroadcast posts the configured segment, sender, and reply-to, and returns the id', async () => {
  const calls = [];
  const fetcher = mockFetch([{ status: 200, body: { id: 'bc_123' } }], calls);
  const id = await createBroadcast({ config: CONFIG, fetcher, subject: 'Hi', name: 'Blog: x', html: '<p>e</p>' });
  assert.equal(id, 'bc_123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/broadcasts');
  const createBody = JSON.parse(calls[0].init.body);
  assert.equal(createBody.segment_id, 'seg_general');
  assert.equal(createBody.from, 'HTV <a@b.co>');
  assert.deepEqual(createBody.reply_to, ['contact@hackthevalley.org']);
  assert.ok(calls[0].init.signal, 'the create has a timeout');
  assert.equal('send' in createBody, false, 'a draft is never sent');
});

test('createBroadcast with send asks Resend to send it as it is created, in the same request', async () => {
  const calls = [];
  await createBroadcast({ config: CONFIG, fetcher: mockFetch([{ status: 200, body: { id: 'bc_sent' } }], calls), subject: 's', name: 'n', html: 'h', send: true });
  assert.deepEqual(calls.map((call) => call.url), ['https://api.resend.com/broadcasts']);
  assert.equal(JSON.parse(calls[0].init.body).send, true);
});

test('sendEmail emails one address through the Email API, never a broadcast', async () => {
  const calls = [];
  const id = await sendEmail({ config: CONFIG, fetcher: mockFetch([{ status: 200, body: { id: 'em_1' } }], calls), to: 'admin@example.com', subject: '[Test] s', html: '<p>h</p>' });
  assert.equal(id, 'em_1');
  assert.equal(calls[0].url, 'https://api.resend.com/emails');
  assert.deepEqual(JSON.parse(calls[0].init.body), { from: 'HTV <a@b.co>', to: ['admin@example.com'], subject: '[Test] s', html: '<p>h</p>', reply_to: ['contact@hackthevalley.org'] });
  await assert.rejects(
    sendEmail({ config: CONFIG, fetcher: mockFetch([{ status: 422, body: { message: 'bad' } }]), to: 'a@b.co', subject: 's', html: 'h' }),
    (error) => error.status === 502 && /HTTP 422/.test(error.message),
  );
});

test('createBroadcast says whether a failed create may still have made the draft', async () => {
  const attempt = (fetcher) => createBroadcast({ config: CONFIG, fetcher, subject: 's', name: 'n', html: 'h' }).then(() => assert.fail('expected a failure'), (error) => error);
  for (const status of [400, 401, 422, 429]) {
    const error = await attempt(mockFetch([{ status, body: { message: 'refused' } }]));
    assert.equal(error.status, 502);
    assert.equal(error.created, false, `HTTP ${status} is a definite refusal`);
  }
  for (const status of [500, 503]) {
    assert.equal((await attempt(mockFetch([{ status, body: {} }]))).created, null, `HTTP ${status} may have created it`);
  }
  assert.equal((await attempt(async () => { throw new TypeError('fetch failed'); })).created, null, 'no answer');
  assert.equal((await attempt(mockFetch([{ status: 200, body: {} }]))).created, null, 'accepted without an id');
});

test('findBroadcast finds a draft by the reference in its name', async () => {
  const resend = createFakeResend();
  await createBroadcast({ config: CONFIG, fetcher: resend.fetch, subject: 's', name: 'Email: s · ref 0123456789ab', html: 'h' });
  assert.deepEqual(await findBroadcast({ config: CONFIG, fetcher: resend.fetch, marker: 'ref 0123456789ab' }), {
    broadcastId: 'bc_1', name: 'Email: s · ref 0123456789ab', segmentId: 'seg_general', status: 'draft',
  });
  assert.equal(await findBroadcast({ config: CONFIG, fetcher: resend.fetch, marker: 'ref ffffffffffff' }), null);
});

// --- "Start from a blog post": GET /api/admin/message-drafts/blog-post -------

test('post route rejects non-admins with 401', async () => {
  const response = await getPost({ request: postRequest('test-post'), env: { HTV_DB: {}, ASSETS: assets() } });
  assert.equal(response.status, 401);
});

test('post route returns the title and body (without page chrome) for an admin', async () => {
  const response = await getPost({ request: postRequest('test-post', { cookie: 'htv_session=tok' }), env: { HTV_DB: adminDb(), ASSETS: assets() } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.slug, 'test-post');
  assert.equal(body.title, 'Test Post');
  assert.match(body.html, /<p>Hello world\.<\/p>/);
  assert.doesNotMatch(body.html, /CTA chrome/);
});

test('post route returns 404 for an unknown slug', async () => {
  const response = await getPost({ request: postRequest('nope', { cookie: 'htv_session=tok' }), env: { HTV_DB: adminDb(), ASSETS: assets() } });
  assert.equal(response.status, 404);
});

test('post route returns 422 (not 404) when posts.json is malformed', async () => {
  const badAssets = assets({ '/blog/posts.json': '{ this is not json', '/blog/test-post': POST_HTML });
  const response = await getPost({ request: postRequest('test-post', { cookie: 'htv_session=tok' }), env: { HTV_DB: adminDb(), ASSETS: badAssets } });
  assert.equal(response.status, 422);
});

test('post route only accepts GET', async () => {
  const response = await postRouteFallback();
  assert.equal(response.status, 405);
});

// --- retired send-log ------------------------------------------------------

test('the blog_broadcast_sends table is history only: no code writes, reads, or reconciles it', () => {
  const root = new URL('../', import.meta.url);
  const sources = ['worker.js'];
  const walk = (dir) => {
    for (const entry of readdirSync(new URL(dir, root), { withFileTypes: true })) {
      const path = `${dir}${entry.name}`;
      if (entry.isDirectory()) walk(`${path}/`);
      else if (path.endsWith('.js')) sources.push(path);
    }
  };
  walk('functions/');
  walk('public/');
  for (const path of sources) {
    const code = readFileSync(new URL(path, root), 'utf8');
    assert.doesNotMatch(code, /(?:FROM|INTO|UPDATE)\s+blog_broadcast_sends|reconcileBroadcastSends|\/api\/blog\/broadcast/, path);
  }
});

// --- real file-backed contract (posts.json <-> pages on disk) ---------------

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

test('blog list page loads posts and renders newest first', () => {
  const html = readFileSync(`${publicDir}blog/index.html`, 'utf8');
  assert.match(html, /fetch\("\/api\/blog\/posts"/);
  assert.match(html, /String\(b\.date \|\| ""\)\.localeCompare\(String\(a\.date \|\| ""\)\)/);
  assert.match(html, /href="\/blog\/\$\{encodeURIComponent\(post\.slug\)\}"/);
});

test('every post in the real posts.json is complete and loadable', () => {
  const manifest = JSON.parse(readFileSync(`${publicDir}blog/posts.json`, 'utf8'));
  assert.ok(Array.isArray(manifest.posts) && manifest.posts.length > 0, 'posts.json must list at least one post');

  for (const post of manifest.posts) {
    // metadata
    assert.ok(post.slug && /^[a-z0-9-]+$/.test(post.slug), `invalid slug: ${JSON.stringify(post.slug)}`);
    assert.ok(post.title && String(post.title).trim(), `post "${post.slug}" is missing a title`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(post.date || ''), `post "${post.slug}" has a missing/invalid date`);

    // page exists
    const pagePath = `${publicDir}blog/${post.slug}/index.html`;
    assert.ok(existsSync(pagePath), `post "${post.slug}" has no index.html`);
    const html = readFileSync(pagePath, 'utf8');

    // non-empty body, proven through the real BlogPost "Start from" uses
    const body = new BlogPost({ slug: post.slug, title: post.title, rawHtml: html }).body();
    assert.ok(body.length > 0, `post "${post.slug}" extracted to an empty body`);

    // every post carries the events CTA
    assert.match(html, /href="\/events"/, `post "${post.slug}" is missing the /events CTA`);

    // local image references resolve on disk
    for (const match of html.matchAll(/<img\b[^>]*\ssrc="([^"]+)"/gi)) {
      const src = match[1];
      if (src.startsWith('/')) {
        assert.ok(existsSync(`${publicDir}${src.slice(1)}`), `post "${post.slug}" references a missing image: ${src}`);
      }
    }
  }
});
