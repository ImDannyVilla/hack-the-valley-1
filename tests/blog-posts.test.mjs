// Blog posts written and published from /admin: the BlogPost rules, the admin
// and public routes, the /blog/<slug> page, and the admin UI wiring. Runs the
// worker against a real SQLite database with every migration applied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import worker from '../worker.js';
import { createSponsorshipDb, DEMO_USERS } from './helpers/sponsorship-db.mjs';
import { sponsorHash } from '../functions/_lib/domain/sponsorships.js';
import { pacificDate, publishBlogPost, saveBlogPost } from '../functions/_lib/domain/blog-post.js';
import { MessageDraft } from '../functions/_lib/domain/message-draft.js';
import { renderBlogPostPage, formatPostDate } from '../functions/_shared/blog-page.js';
import { postStateLabel, slugify } from '../public/admin-blog-posts.js';

const FILE_MANIFEST = JSON.stringify({
  posts: [{ slug: 'welcome', title: 'Welcome', description: 'Hello', excerpt: 'Hi there', date: '2026-06-18' }],
});
const FILE_PAGE = '<html><body><!-- POST:START --><p>Welcome body</p><!-- POST:END --></body></html>';

// Static assets: one file-based post. Anything else is a 404, like the real
// asset store.
const ASSETS = {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/blog/posts.json') return new Response(FILE_MANIFEST, { headers: { 'content-type': 'application/json' } });
    if (pathname === '/blog/welcome' || pathname === '/blog/welcome/') return new Response(FILE_PAGE, { headers: { 'content-type': 'text/html' } });
    return new Response('not found', { status: 404 });
  },
};

async function setup(t) {
  const { db, close } = await createSponsorshipDb();
  t.after(close);
  for (const [name, userId] of Object.entries(DEMO_USERS)) {
    await db.prepare('INSERT INTO user_sessions(id,user_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)')
      .bind(`session-${name}`, userId, await sponsorHash(`token-${name}`), '2026-01-01', '2099-01-01').run();
  }
  return { HTV_DB: db, ASSETS };
}

function call(env, method, path, { user = 'alex', body } = {}) {
  const headers = {};
  if (user) headers.cookie = `htv_session=token-${user}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return worker.fetch(new Request(`https://hackthevalley.org${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
}

const ID = `post_${'a'.repeat(32)}`;
const OTHER_ID = `post_${'b'.repeat(32)}`;
const POST = {
  revision: 0,
  title: 'Project Spotlight: TechPath Kern',
  slug: 'techpath-kern',
  summary: 'A student-built opportunity navigator.',
  body: '## What it does\nHelps **Kern County** students find [scholarships](https://example.org).\n\n![Screenshot](/api/email-images/img_0123456789abcdef.png){width=360}',
};

async function json(response) {
  return { status: response.status, body: await response.json() };
}

async function auditActions(env, id) {
  const { results } = await env.HTV_DB.prepare('SELECT action FROM audit_events WHERE target_id = ? ORDER BY rowid').bind(id).all();
  return results.map((row) => row.action);
}

// --- access ------------------------------------------------------------------

test('admin blog routes need a signed-in admin', async (t) => {
  const env = await setup(t);
  for (const [method, path, body] of [
    ['GET', '/api/admin/blog-posts'],
    ['GET', `/api/admin/blog-posts/${ID}`],
    ['PUT', `/api/admin/blog-posts/${ID}`, POST],
    ['POST', `/api/admin/blog-posts/${ID}/publish`],
    ['POST', '/api/admin/blog-posts/preview', POST],
  ]) {
    assert.equal((await call(env, method, path, { user: null, body })).status, 401, `${method} ${path} anonymous`);
    assert.equal((await call(env, method, path, { user: 'member', body })).status, 403, `${method} ${path} member`);
  }
});

// --- drafts ------------------------------------------------------------------

test('a new post is saved as a draft that the public cannot see', async (t) => {
  const env = await setup(t);
  const saved = await json(await call(env, 'PUT', `/api/admin/blog-posts/${ID}`, { body: POST }));
  assert.equal(saved.status, 200);
  assert.equal(saved.body.post.status, 'draft');
  assert.equal(saved.body.post.revision, 1);
  assert.equal(saved.body.post.postDate, null);

  const listed = await json(await call(env, 'GET', '/api/blog/posts', { user: null }));
  assert.deepEqual(listed.body.posts.map((post) => post.slug), ['welcome']);
  assert.equal((await call(env, 'GET', '/blog/techpath-kern', { user: null })).status, 404);
});

test('saving is safe to retry and refuses to overwrite a newer edit', async (t) => {
  const env = await setup(t);
  await call(env, 'PUT', `/api/admin/blog-posts/${ID}`, { body: POST });
  const retry = await json(await call(env, 'PUT', `/api/admin/blog-posts/${ID}`, { body: POST }));
  assert.equal(retry.status, 200, 'retrying the same create returns the stored post');
  assert.equal(retry.body.post.revision, 1);
  const { results } = await env.HTV_DB.prepare('SELECT COUNT(*) AS n FROM blog_posts').all();
  assert.equal(results[0].n, 1);

  const edited = await json(await call(env, 'PUT', `/api/admin/blog-posts/${ID}`, { body: { ...POST, revision: 1, title: 'Edited' } }));
  assert.equal(edited.body.post.revision, 2);
  const stale = await call(env, 'PUT', `/api/admin/blog-posts/${ID}`, { body: { ...POST, revision: 1, title: 'Stale edit' } });
  assert.equal(stale.status, 409);
});

test('post content is validated', async (t) => {
  const env = await setup(t);
  const save = (overrides, id = ID) => call(env, 'PUT', `/api/admin/blog-posts/${id}`, { body: { ...POST, ...overrides } });
  assert.equal((await save({ title: '' })).status, 400);
  assert.equal((await save({ body: '' })).status, 400);
  assert.equal((await save({ slug: 'Not A Slug!' })).status, 400);
  assert.equal((await save({ slug: 'admin' })).status, 400);
  const fields = await json(await save({ body: 'Hi {{{contact.first_name|there}}}' }));
  assert.equal(fields.status, 400);
  assert.match(fields.body.error, /only work in emails/);
  assert.equal((await save({ slug: 'welcome' })).status, 409, 'a file-based post already uses the URL');
  assert.equal((await call(env, 'PUT', '/api/admin/blog-posts/not-an-id', { body: POST })).status, 400);

  await save({});
  assert.equal((await save({ title: 'Another' }, OTHER_ID)).status, 409, 'another admin post already uses the URL');
});

// --- publishing --------------------------------------------------------------

test('publishing puts the post on the blog, in the list, and in the audit log', async (t) => {
  const env = await setup(t);
  await call(env, 'PUT', `/api/admin/blog-posts/${ID}`, { body: POST });
  const published = await json(await call(env, 'POST', `/api/admin/blog-posts/${ID}/publish`));
  assert.equal(published.status, 200);
  assert.equal(published.body.post.status, 'published');
  assert.match(published.body.post.postDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(published.body.post.url, '/blog/techpath-kern');

  const listed = await json(await call(env, 'GET', '/api/blog/posts', { user: null }));
  assert.deepEqual(listed.body.posts.map((post) => [post.slug, post.source]), [['techpath-kern', 'admin'], ['welcome', 'file']]);
  assert.equal(listed.body.posts[0].excerpt, POST.summary);

  const page = await call(env, 'GET', '/blog/techpath-kern', { user: null });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.match(html, /<title>Project Spotlight: TechPath Kern \| Hack the Valley<\/title>/);
  assert.match(html, /<h2>What it does<\/h2>/);
  assert.match(html, /<strong>Kern County<\/strong>/);
  assert.match(html, /<img src="\/api\/email-images\/img_0123456789abcdef\.png" alt="Screenshot" width="360">/);
  assert.match(html, /Sign up for our next event/);
  assert.equal((await call(env, 'GET', '/blog/techpath-kern/', { user: null })).status, 200, 'trailing slash works too');

  const again = await json(await call(env, 'POST', `/api/admin/blog-posts/${ID}/publish`));
  assert.equal(again.body.post.postDate, published.body.post.postDate, 'publishing again keeps the date');
  assert.deepEqual(await auditActions(env, ID), ['blog_post.publish'], 'publishing again is not a second publish');
});

test('a published post keeps its URL, and live edits are audited', async (t) => {
  const env = await setup(t);
  await call(env, 'PUT', `/api/admin/blog-posts/${ID}`, { body: POST });
  await call(env, 'POST', `/api/admin/blog-posts/${ID}/publish`);
  const moved = await json(await call(env, 'PUT', `/api/admin/blog-posts/${ID}`, { body: { ...POST, revision: 1, slug: 'renamed' } }));
  assert.equal(moved.status, 409);
  assert.match(moved.body.error, /can't change after a post has been published/);

  const edited = await json(await call(env, 'PUT', `/api/admin/blog-posts/${ID}`, { body: { ...POST, revision: 1, title: 'Updated title' } }));
  assert.equal(edited.status, 200);
  assert.match(await (await call(env, 'GET', '/blog/techpath-kern', { user: null })).text(), /Updated title/);
  assert.deepEqual(await auditActions(env, ID), ['blog_post.publish', 'blog_post.update']);
});

test('unpublishing takes the post down but keeps its URL reserved', async (t) => {
  const env = await setup(t);
  await call(env, 'PUT', `/api/admin/blog-posts/${ID}`, { body: POST });
  await call(env, 'POST', `/api/admin/blog-posts/${ID}/publish`);
  const unpublished = await json(await call(env, 'POST', `/api/admin/blog-posts/${ID}/unpublish`));
  assert.equal(unpublished.body.post.status, 'draft');
  assert.equal((await call(env, 'GET', '/blog/techpath-kern', { user: null })).status, 404);
  const listed = await json(await call(env, 'GET', '/api/blog/posts', { user: null }));
  assert.deepEqual(listed.body.posts.map((post) => post.slug), ['welcome']);
  assert.equal((await call(env, 'PUT', `/api/admin/blog-posts/${ID}`, { body: { ...POST, revision: 1, slug: 'renamed' } })).status, 409);
  assert.deepEqual(await auditActions(env, ID), ['blog_post.publish', 'blog_post.unpublish']);
});

// --- the audit trail is part of each change ----------------------------------

// Make every blog audit write fail, to prove a change is never stored without
// its audit event.
const breakBlogAudits = (env) => env.HTV_DB.exec("CREATE TRIGGER fail_blog_audit BEFORE INSERT ON audit_events WHEN NEW.target_type = 'blog_post' BEGIN SELECT RAISE(ABORT, 'audit store unavailable'); END");
const fixBlogAudits = (env) => env.HTV_DB.exec('DROP TRIGGER fail_blog_audit');
const storedPost = async (env) => (await json(await call(env, 'GET', `/api/admin/blog-posts/${ID}`))).body.post;

test('a publish whose audit write fails is not stored, so a retry publishes and audits it', async (t) => {
  const env = await setup(t);
  await call(env, 'PUT', `/api/admin/blog-posts/${ID}`, { body: POST });
  await breakBlogAudits(env);
  const failed = await json(await call(env, 'POST', `/api/admin/blog-posts/${ID}/publish`));
  assert.equal(failed.status, 500);
  assert.match(failed.body.error, /audit record, so nothing was changed/);
  assert.equal((await storedPost(env)).status, 'draft');
  assert.equal((await call(env, 'GET', '/blog/techpath-kern', { user: null })).status, 404, 'not live');
  assert.deepEqual(await auditActions(env, ID), []);

  await fixBlogAudits(env);
  const retried = await json(await call(env, 'POST', `/api/admin/blog-posts/${ID}/publish`));
  assert.equal(retried.body.post.status, 'published');
  assert.deepEqual(await auditActions(env, ID), ['blog_post.publish'], 'the retry is audited');
});

test('unpublishing or editing a live post is not stored when its audit write fails', async (t) => {
  const env = await setup(t);
  await call(env, 'PUT', `/api/admin/blog-posts/${ID}`, { body: POST });
  await call(env, 'POST', `/api/admin/blog-posts/${ID}/publish`);
  await breakBlogAudits(env);
  assert.equal((await call(env, 'PUT', `/api/admin/blog-posts/${ID}`, { body: { ...POST, revision: 1, title: 'Edited live' } })).status, 500);
  assert.equal((await call(env, 'POST', `/api/admin/blog-posts/${ID}/unpublish`)).status, 500);
  const post = await storedPost(env);
  assert.deepEqual([post.status, post.title, post.revision], ['published', POST.title, 1], 'neither change was stored');
  assert.equal((await call(env, 'GET', '/blog/techpath-kern', { user: null })).status, 200, 'still live');
  assert.deepEqual(await auditActions(env, ID), ['blog_post.publish']);

  await fixBlogAudits(env);
  assert.equal((await call(env, 'PUT', `/api/admin/blog-posts/${ID}`, { body: { ...POST, revision: 1, title: 'Edited live' } })).status, 200);
  assert.equal((await json(await call(env, 'POST', `/api/admin/blog-posts/${ID}/unpublish`))).body.post.status, 'draft');
  assert.deepEqual(await auditActions(env, ID), ['blog_post.publish', 'blog_post.update', 'blog_post.unpublish']);
});

test('saving a draft does not depend on the audit log', async (t) => {
  const env = await setup(t);
  await call(env, 'PUT', `/api/admin/blog-posts/${ID}`, { body: POST });
  await breakBlogAudits(env);
  const saved = await json(await call(env, 'PUT', `/api/admin/blog-posts/${ID}`, { body: { ...POST, revision: 1, title: 'Draft edit' } }));
  assert.equal(saved.status, 200, 'drafts are not public, so their edits are not audited');
  assert.equal(saved.body.post.revision, 2);
});

// A database whose next batch first runs `competing`, as if another admin's
// change landed after this request read the post and before it wrote.
function racingDb(db, competing) {
  let raced = false;
  return {
    prepare: db.prepare.bind(db),
    async batch(statements) {
      if (!raced) {
        raced = true;
        await competing();
      }
      return db.batch(statements);
    },
  };
}

test('a publish that races another publish is stored and audited once', async (t) => {
  const env = await setup(t);
  await call(env, 'PUT', `/api/admin/blog-posts/${ID}`, { body: POST });
  const db = racingDb(env.HTV_DB, () => publishBlogPost(env.HTV_DB, ID, { actorUserId: DEMO_USERS.danny }));
  const post = await publishBlogPost(db, ID, { actorUserId: DEMO_USERS.alex });
  assert.equal(post.status, 'published');
  const { results } = await env.HTV_DB.prepare('SELECT action, actor_user_id FROM audit_events WHERE target_id = ?').bind(ID).all();
  assert.deepEqual(results.map((row) => [row.action, row.actor_user_id]), [['blog_post.publish', DEMO_USERS.danny]]);
});

test('an edit that races another edit is refused and leaves no audit event', async (t) => {
  const env = await setup(t);
  await call(env, 'PUT', `/api/admin/blog-posts/${ID}`, { body: POST });
  await call(env, 'POST', `/api/admin/blog-posts/${ID}/publish`);
  const db = racingDb(env.HTV_DB, () => env.HTV_DB.prepare('UPDATE blog_posts SET title = ?, revision = revision + 1 WHERE id = ?').bind('Their edit', ID).run());
  await assert.rejects(
    saveBlogPost(db, ID, { ...POST, revision: 1, title: 'My edit' }, { actorUserId: DEMO_USERS.alex, assets: ASSETS, origin: 'https://hackthevalley.org' }),
    (error) => error.status === 409,
  );
  assert.equal((await storedPost(env)).title, 'Their edit');
  assert.deepEqual(await auditActions(env, ID), ['blog_post.publish']);
});

test('the admin list shows admin posts for editing and file posts read-only', async (t) => {
  const env = await setup(t);
  await call(env, 'PUT', `/api/admin/blog-posts/${ID}`, { body: POST });
  const listed = await json(await call(env, 'GET', '/api/admin/blog-posts'));
  assert.deepEqual(listed.body.posts.map((post) => [post.id, post.status]), [[ID, 'draft']]);
  assert.deepEqual(listed.body.filePosts.map((post) => post.slug), ['welcome']);
  const one = await json(await call(env, 'GET', `/api/admin/blog-posts/${ID}`));
  assert.equal(one.body.post.body, POST.body);
  assert.equal((await call(env, 'GET', `/api/admin/blog-posts/${OTHER_ID}`)).status, 404);
});

test('preview renders the public page for unsaved content without saving it', async (t) => {
  const env = await setup(t);
  const preview = await json(await call(env, 'POST', '/api/admin/blog-posts/preview', { body: { title: '<Draft> & co', body: 'Hello' } }));
  assert.equal(preview.status, 200);
  assert.match(preview.body.html, /&lt;Draft&gt; &amp; co/);
  assert.match(preview.body.html, /Draft preview/);
  assert.match(preview.body.html, /<p>Hello<\/p>/);
  const { results } = await env.HTV_DB.prepare('SELECT COUNT(*) AS n FROM blog_posts').all();
  assert.equal(results[0].n, 0);
  assert.equal((await call(env, 'POST', '/api/admin/blog-posts/preview', { body: { body: '{{{contact.email}}}' } })).status, 400);
});

test('file-based posts are still served by the asset store, not the database', async (t) => {
  const env = await setup(t);
  const page = await call(env, 'GET', '/blog/welcome', { user: null });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Welcome body/);
});

// --- email: "Start from" a post published from admin ---------------------------

test('an email can start from a post published from admin', async (t) => {
  const env = await setup(t);
  await call(env, 'PUT', `/api/admin/blog-posts/${ID}`, { body: POST });
  await call(env, 'POST', `/api/admin/blog-posts/${ID}/publish`);

  const loaded = await json(await call(env, 'GET', '/api/admin/message-drafts/blog-post?slug=techpath-kern'));
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.title, POST.title);
  assert.match(loaded.body.html, /<h2>What it does<\/h2>/);

  const draft = await MessageDraft.fromInput({ subject: 's', message: 'm', postSlug: 'techpath-kern' }, { assets: ASSETS, origin: 'https://hackthevalley.org', db: env.HTV_DB });
  assert.match(draft.toEmailHtml({ baseUrl: 'https://hackthevalley.org' }), /Read this on the web: <a href="https:\/\/hackthevalley\.org\/blog\/techpath-kern"/);
  assert.equal(draft.broadcastName(), `Blog: ${POST.title}`);

  await call(env, 'POST', `/api/admin/blog-posts/${ID}/unpublish`);
  assert.equal((await call(env, 'GET', '/api/admin/message-drafts/blog-post?slug=techpath-kern')).status, 404, 'drafts cannot be emailed');
});

// --- page rendering and helpers ---------------------------------------------------

const blockBetween = (html, start, end) => {
  const from = html.indexOf(start);
  return html.slice(from, html.indexOf(end, from) + end.length).replace(/\s+/g, ' ');
};

test('admin post pages use the same nav, call to action, and footer as file-based posts', () => {
  const template = readFileSync(new URL('../public/blog/welcome-to-the-hack-the-valley-blog/index.html', import.meta.url), 'utf8');
  const rendered = renderBlogPostPage({ title: 'T', date: '2026-10-29', bodyHtml: '<p>x</p>' });
  for (const [start, end] of [['<nav', '</nav>'], ['<!-- CTA:START', '<!-- CTA:END -->'], ['<footer', '</footer>']]) {
    assert.equal(blockBetween(rendered, start, end), blockBetween(template, start, end), start);
  }
  assert.match(rendered, /October 29, 2026/);
});

test('post dates use the Pacific calendar day', () => {
  assert.equal(pacificDate(new Date('2026-10-30T05:30:00Z')), '2026-10-29');
  assert.equal(pacificDate(new Date('2026-10-30T08:00:00Z')), '2026-10-30');
  assert.equal(formatPostDate('2026-06-18'), 'June 18, 2026');
  assert.equal(formatPostDate('not a date'), '');
});

test('the composer suggests URLs from titles and labels post states', () => {
  assert.equal(slugify('Project Spotlight: TechPath Kern!'), 'project-spotlight-techpath-kern');
  assert.equal(slugify('  Café & Code — Nov 7  '), 'cafe-code-nov-7');
  assert.equal(slugify('x'.repeat(100)).length, 80);
  assert.equal(postStateLabel({ revision: 0 }), 'Not saved yet');
  assert.equal(postStateLabel({ revision: 2, status: 'draft', publishedAt: null }), 'Draft');
  assert.equal(postStateLabel({ revision: 2, status: 'published', postDate: '2026-10-29' }), 'Published · 2026-10-29');
  assert.equal(postStateLabel({ revision: 3, status: 'draft', publishedAt: '2026-10-29T00:00:00Z' }), 'Unpublished (draft)');
});

test('admin page has a Blog section whose editor has no email-only field chips', () => {
  const html = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
  assert.match(html, /data-admin-nav="blog"/);
  assert.match(html, /<section id="blog-posts" data-admin-section="blog"/);
  assert.match(html, /<script type="module" src="\/admin-blog-posts\.js"><\/script>/);
  const start = html.indexOf('<section id="blog-editor"');
  const editor = html.slice(start, html.indexOf('</section>', start));
  assert.match(editor, /id="blog-body-editor" contenteditable="true"/);
  assert.match(editor, /id="blog-publish"/);
  assert.doesNotMatch(editor, /data-message-field/);
  const js = readFileSync(new URL('../public/admin-blog-posts.js', import.meta.url), 'utf8');
  assert.match(js, /allowFields: false/);
  assert.match(js, /revision: post\.revision/);
});

test('the public blog index lists posts from the merged API', () => {
  const html = readFileSync(new URL('../public/blog/index.html', import.meta.url), 'utf8');
  assert.match(html, /fetch\("\/api\/blog\/posts"/);
});
