import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  absolutizeUrls,
  buildBroadcastEmailHtml,
} from '../functions/_shared/blog-broadcast.js';
import { BlogPost } from '../functions/_lib/domain/blog-post.js';
import {
  createBroadcast,
  createDraftEmail,
  resolveBroadcastConfig,
  resolveDraftSegmentId,
} from '../functions/_lib/domain/blog-broadcast.js';
import { onRequestGet as getPost, onRequest as postRouteFallback } from '../functions/api/admin/quick-email/post.js';

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
  return new Request(`https://hackthevalley.org/api/admin/quick-email/post?slug=${encodeURIComponent(slug)}`, { headers });
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

test('buildBroadcastEmailHtml includes title, upcoming-events CTA, submission CTA, and unsubscribe token', () => {
  const html = buildBroadcastEmailHtml({
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

test('buildBroadcastEmailHtml constrains image width inline so screenshots do not overflow', () => {
  const html = buildBroadcastEmailHtml({
    title: 'P',
    contentHtml: '<figure><img src="https://h.org/images/big.png" alt="x"><figcaption>cap</figcaption></figure>',
  });
  // the <img> must get an inline max-width (email clients ignore <style>)
  assert.match(html, /<img style="[^"]*max-width:100%[^"]*"\s+src="https:\/\/h\.org\/images\/big\.png"/);
  assert.match(html, /<figcaption style="[^"]*text-align:center/);
});

test('resolveBroadcastConfig requires an API key and sender', () => {
  assert.throws(() => resolveBroadcastConfig({}), (err) => {
    return err.status === 503 && /RESEND_API_KEY/.test(err.message) && /RESEND_BROADCAST_FROM/.test(err.message);
  });
  const config = resolveBroadcastConfig({ RESEND_API_KEY: 'k', RESEND_BROADCAST_FROM: 'HTV <a@b.co>' });
  assert.equal(config.from, 'HTV <a@b.co>');
  assert.equal(config.replyTo, 'contact@hackthevalley.org');
  const custom = resolveBroadcastConfig({ RESEND_API_KEY: 'k', RESEND_BROADCAST_FROM: 'HTV <a@b.co>', RESEND_BROADCAST_REPLY_TO: 'blog@hackthevalley.org' });
  assert.equal(custom.replyTo, 'blog@hackthevalley.org');
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
    RESEND_FROM: 'legacy@b.co', RESEND_FROM_EMAIL: 'also-legacy@b.co',
  });
  assert.equal(config.from, 'HTV <a@b.co>');
});

test('resolveDraftSegmentId uses an existing safe placeholder and does not inspect contacts', async () => {
  const calls = [];
  const fetcher = mockFetch([
    { status: 200, body: { data: [{ id: 'seg_event', name: 'Hack the Valley 2026' }, { id: 'seg_general', name: 'General' }] } },
  ], calls);
  const draft = await resolveDraftSegmentId({ env: { RESEND_API_KEY: 'k' }, fetcher });
  assert.deepEqual(draft, { segmentId: 'seg_general', segmentName: 'General', source: 'auto-discovered-placeholder' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/segments?limit=100');
});

test('resolveDraftSegmentId refuses to auto-pick an unsafe populated-looking segment', async () => {
  const calls = [];
  const fetcher = mockFetch([
    { status: 200, body: { data: [{ id: 'seg_htv_2026', name: 'Hack the Valley 2026' }], has_more: false } },
  ], calls);

  await assert.rejects(
    resolveDraftSegmentId({ env: { RESEND_API_KEY: 'rk_test' }, fetcher }),
    /safe placeholder segment/,
  );
});

test('createBroadcast posts the Resend segment/from and returns the id', async () => {
  const calls = [];
  const fetcher = mockFetch([{ status: 200, body: { id: 'bc_123' } }], calls);
  const id = await createBroadcast({
    env: { RESEND_API_KEY: 'k' }, fetcher,
    audienceId: 'aud_1', from: 'HTV <a@b.co>', replyTo: 'contact@hackthevalley.org', subject: 'Hi', name: 'Blog: x', html: '<p>e</p>',
  });
  assert.equal(id, 'bc_123');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/broadcasts');
  const createBody = JSON.parse(calls[0].init.body);
  assert.equal(createBody.segment_id, 'aud_1');
  assert.equal(createBody.from, 'HTV <a@b.co>');
  assert.deepEqual(createBody.reply_to, ['contact@hackthevalley.org']);
});

test('createBroadcast throws 502 if create fails', async () => {
  const fetcher = mockFetch([{ status: 400, body: { message: 'bad' } }]);
  await assert.rejects(
    createBroadcast({ env: { RESEND_API_KEY: 'k' }, fetcher, audienceId: 'a', from: 'f', subject: 's', html: 'h' }),
    (err) => err.status === 502,
  );
});

test('createDraftEmail returns 409 when no safe draft placeholder segment exists', async () => {
  const calls = [];
  await assert.rejects(
    createDraftEmail({
      subject: 's', name: 'n', html: '<p>e</p>',
      env: { RESEND_API_KEY: 'k', RESEND_BROADCAST_FROM: 'HTV <a@b.co>' },
      fetcher: mockFetch([
        { status: 200, body: { data: [{ id: 'seg_event', name: 'Hack the Valley 2026' }, { id: 'seg_alumni', name: 'Alumni' }] } },
      ], calls),
    }),
    (error) => error.status === 409 && /requires segment_id even to create a draft/.test(error.message),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.resend.com/segments?limit=100');
});

// --- "Start from a blog post": GET /api/admin/quick-email/post --------------

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
  assert.match(html, /fetch\("\/blog\/posts\.json"/);
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
