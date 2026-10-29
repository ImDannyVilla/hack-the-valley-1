// BlogPost domain object: the one home for "a blog post" (a ContentItem in
// docs/domain-model.md).
//
// Posts come from two places, and callers never see the difference:
//   - file-based posts: static pages under public/blog/, listed in posts.json,
//     whose body sits between HTML-comment markers (authored in the repo);
//   - admin posts: rows in blog_posts (migration 0032), written in the admin
//     message format (functions/_shared/message-format.js) and published from
//     /admin.
// Callers load a BlogPost and ask it for its body / web URL, list published
// posts, and save, publish, or unpublish admin posts through the functions
// below. Publishing is the human approval step for this public content, so
// publish, unpublish, and edits to a live post are audited, in the same
// transaction as the change.

import { renderBlogPostPage } from '../../_shared/blog-page.js';
import { messageBodyHtml } from '../../_shared/message-format.js';
import { auditEventStatement, buildAuditEvent } from './audit.js';

// Implementation detail: where a file-based post's body starts/ends. PRIVATE
// on purpose — nothing outside this module should know posts use markers.
const POST_START = '<!-- POST:START -->';
const POST_END = '<!-- POST:END -->';

function httpError(message, status, extra) {
  return Object.assign(new Error(message), { status }, extra || {});
}

export class BlogPost {
  #rawHtml;
  #message;

  constructor({ slug, title = null, excerpt = null, description = null, date = null, rawHtml = '', message = null, source = 'file' } = {}) {
    this.slug = String(slug || '').trim();
    this.title = title;
    this.excerpt = excerpt;
    this.description = description;
    this.date = date;
    this.source = source;
    this.#rawHtml = String(rawHtml || '');
    this.#message = message === null ? null : String(message);
  }

  // The article body as HTML, however the post is stored.
  body() {
    if (this.#message !== null) {
      const html = messageBodyHtml(this.#message);
      if (!html) throw httpError('Post content is empty.', 422);
      return html;
    }
    const start = this.#rawHtml.indexOf(POST_START);
    const end = this.#rawHtml.indexOf(POST_END);
    if (start === -1 || end === -1 || end < start) {
      throw httpError('Post is missing its <!-- POST:START -->/<!-- POST:END --> markers.', 422);
    }
    const content = this.#rawHtml.slice(start + POST_START.length, end).trim();
    if (!content) {
      throw httpError('Post content between the markers is empty.', 422);
    }
    return content;
  }

  // Public web URL of the post.
  webUrl(baseUrl) {
    return `${String(baseUrl || '').replace(/\/+$/, '')}/blog/${encodeURIComponent(this.slug)}`;
  }

  // Resend broadcast name (internal label, not shown to recipients) for an
  // email started from this post.
  broadcastName() {
    return `Blog: ${this.title || this.slug}`;
  }

  // The public page for an admin post. File-based posts are their own static
  // pages under public/blog/.
  toPageHtml({ draft = false } = {}) {
    return renderBlogPostPage({ title: this.title, description: this.description, date: this.date, bodyHtml: this.body(), draft });
  }

  // The card shown on the blog index.
  listing() {
    return { slug: this.slug, title: this.title, description: this.description, excerpt: this.excerpt, date: this.date, source: this.source };
  }
}

// --- read side (public) -------------------------------------------------------

function postFromRow(row) {
  return new BlogPost({
    slug: row.slug,
    title: row.title,
    excerpt: row.summary,
    description: row.summary,
    date: row.post_date,
    message: row.body,
    source: 'admin',
  });
}

// Load a published post by slug: an admin post (when a database is given) or a
// file-based one. Drafts are never returned.
export async function loadBlogPost(assets, slug, { origin, db = null } = {}) {
  const normalizedSlug = String(slug || '').trim();
  if (!normalizedSlug) throw httpError('A post slug is required.', 400);

  if (db) {
    const row = await db
      .prepare("SELECT slug, title, summary, body, post_date FROM blog_posts WHERE slug = ? AND status = 'published'")
      .bind(normalizedSlug)
      .first();
    if (row) return postFromRow(row);
  }

  const entry = (await readManifest(assets, origin)).find((post) => post && post.slug === normalizedSlug);
  if (!entry) {
    throw httpError(`No published post with slug "${normalizedSlug}".`, 404);
  }

  const pageResponse = await assetFetch(assets, origin, `/blog/${encodeURIComponent(normalizedSlug)}`);
  if (!pageResponse || !pageResponse.ok) {
    throw httpError(`Could not load the post page for "${normalizedSlug}".`, 404);
  }
  const rawHtml = await pageResponse.text();

  return new BlogPost({
    slug: normalizedSlug,
    title: entry.title,
    excerpt: entry.excerpt,
    description: entry.description,
    date: entry.date,
    rawHtml,
  });
}

// Every published post, newest first: file-based posts from posts.json plus
// published admin posts (when a database is given).
export async function listPublishedBlogPosts({ assets, origin, db = null } = {}) {
  const files = (await readManifest(assets, origin)).map((entry) => ({
    slug: entry.slug,
    title: entry.title,
    description: entry.description || null,
    excerpt: entry.excerpt || null,
    date: entry.date || null,
    source: 'file',
  }));
  const rows = db
    ? (await db.prepare("SELECT slug, title, summary, body, post_date FROM blog_posts WHERE status = 'published'").all()).results || []
    : [];
  return [...files, ...rows.map((row) => postFromRow(row).listing())]
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

// The file-based posts listed in posts.json. This is the only place that knows
// file posts live as posts.json + pages; the assets binding is injected so it
// stays testable.
async function readManifest(assets, origin) {
  if (!assets?.fetch) throw httpError('Static assets binding is unavailable.', 500);
  const manifestResponse = await assetFetch(assets, origin, '/blog/posts.json');
  if (!manifestResponse || !manifestResponse.ok) {
    throw httpError('Could not load the blog manifest (posts.json).', 502);
  }
  let manifest;
  try {
    manifest = await manifestResponse.json();
  } catch {
    throw httpError('Blog manifest is invalid (posts.json could not be parsed).', 422);
  }
  if (!manifest || !Array.isArray(manifest.posts)) {
    throw httpError('Blog manifest is invalid (missing a "posts" array).', 422);
  }
  return manifest.posts.filter((post) => post && post.slug);
}

function assetFetch(assets, origin, path) {
  const url = new URL(path, origin).toString();
  return assets.fetch(new Request(url, { headers: { Accept: '*/*' } }));
}

// --- write side (admin posts) -----------------------------------------------

export const BLOG_POST_LIMITS = Object.freeze({ title: 150, slug: 80, summary: 300, body: 50000 });

const POST_ID = /^post_[a-f0-9]{32}$/;
const FIELD_TOKEN = /\{\{\{[^{}]+\}\}\}/;
const FIELD_TOKEN_ERROR = 'Personalized fields like First name only work in emails, not on the blog.';
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_SLUGS = new Set(['admin', 'drafts', 'feed', 'index', 'new', 'posts', 'rss']);

function text(value, label, max, { required = false } = {}) {
  const trimmed = String(value ?? '').trim();
  if (required && !trimmed) throw httpError(`${label} is required.`, 400);
  if (trimmed.length > max) throw httpError(`${label} must be ${max} characters or fewer.`, 400);
  return trimmed;
}

// The admin-facing shape of a stored post (camelCase).
export function toBlogPostRecord(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    body: row.body,
    status: row.status,
    postDate: row.post_date || null,
    publishedAt: row.published_at || null,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    url: `/blog/${row.slug}`,
  };
}

// Validate an admin post's content. Personalized fields only exist in emails
// (Resend fills them per contact), so they are refused here.
export function validateBlogPostInput(input = {}) {
  const title = text(input.title, 'Title', BLOG_POST_LIMITS.title, { required: true });
  const slug = text(input.slug, 'URL', BLOG_POST_LIMITS.slug, { required: true }).toLowerCase();
  if (!SLUG.test(slug)) {
    throw httpError('The URL can use lowercase letters, numbers, and single dashes (like "november-update").', 400);
  }
  if (RESERVED_SLUGS.has(slug)) throw httpError(`"${slug}" is reserved. Choose another URL.`, 400);
  const summary = text(input.summary, 'Summary', BLOG_POST_LIMITS.summary);
  const body = text(input.body, 'Post', BLOG_POST_LIMITS.body, { required: true });
  if (FIELD_TOKEN.test(body)) throw httpError(FIELD_TOKEN_ERROR, 400);
  return { slug, title, summary, body };
}

// The public page for unsaved editor content, so admins see exactly what
// Publish would put on the site. Only the content needs to be valid.
export function previewBlogPost(input = {}) {
  const title = text(input.title, 'Title', BLOG_POST_LIMITS.title) || 'Untitled post';
  const summary = text(input.summary, 'Summary', BLOG_POST_LIMITS.summary);
  const body = text(input.body, 'Post', BLOG_POST_LIMITS.body, { required: true });
  if (FIELD_TOKEN.test(body)) throw httpError(FIELD_TOKEN_ERROR, 400);
  return new BlogPost({ slug: 'preview', title, description: summary, message: body, source: 'admin' }).toPageHtml({ draft: true });
}

function postId(id) {
  const value = String(id || '').trim();
  if (!POST_ID.test(value)) throw httpError('Invalid post id.', 400);
  return value;
}

async function findRow(db, id) {
  return db.prepare('SELECT * FROM blog_posts WHERE id = ?').bind(id).first();
}

async function requireRow(db, id) {
  const row = await findRow(db, id);
  if (!row) throw httpError('Post not found.', 404);
  return row;
}

function isUniqueSlugError(error) {
  return /UNIQUE constraint failed: blog_posts\.slug/i.test(String(error?.message || ''));
}

function slugTaken(slug) {
  return httpError(`Another post already uses /blog/${slug}. Choose another URL.`, 409);
}

// The audit event for a change to a live post, or to whether it is live.
function auditEvent(action, post, actorUserId, at) {
  return buildAuditEvent({
    action,
    actorUserId,
    targetType: 'blog_post',
    targetId: post.id,
    scopeType: 'global',
    scopeId: '*',
    metadata: { slug: post.slug, title: post.title },
    createdAt: at,
  });
}

// Store a change to a post together with its audit event (if any) as one D1
// batch, which is a transaction: both are stored or neither is. The batch is
// guarded by the revision and status read in `row` (blog_post_write_guards,
// migration 0032), so if another change landed in between, nothing is written
// and this returns false. Any other failure throws, also having written nothing.
async function commitChange(db, row, change, audit = null) {
  const guardId = `guard_${crypto.randomUUID().replaceAll('-', '')}`;
  const statements = [
    db
      .prepare(
        `INSERT INTO blog_post_write_guards (id, valid)
         VALUES (?, (SELECT COUNT(*) FROM blog_posts WHERE id = ? AND revision = ? AND status = ?))`
      )
      .bind(guardId, row.id, row.revision, row.status),
    change,
    ...(audit ? [auditEventStatement(db, audit)] : []),
    db.prepare('DELETE FROM blog_post_write_guards WHERE id = ?').bind(guardId),
  ];
  try {
    await db.batch(statements);
    return true;
  } catch (error) {
    const current = await findRow(db, row.id);
    if (!current || Number(current.revision) !== Number(row.revision) || current.status !== row.status) return false;
    if (isUniqueSlugError(error)) throw error;
    const what = audit ? 'this change and its audit record' : 'this change';
    throw httpError(`Couldn't store ${what}, so nothing was changed. Try again.`, 500, { cause: error });
  }
}

// The date shown on a post: today in Bakersfield, not UTC.
export function pacificDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export async function getBlogPostRecord(db, id) {
  return toBlogPostRecord(await requireRow(db, postId(id)));
}

// Every admin post (drafts and published), most recently edited first.
export async function listBlogPostRecords(db) {
  const query = await db.prepare('SELECT * FROM blog_posts ORDER BY updated_at DESC').all();
  return (query?.results || []).map(toBlogPostRecord);
}

// Create or update an admin post. The id comes from the composer (one per new
// post) and `revision` names the version being edited (0 for a new post), so:
//   - repeating a save with the same content returns the stored post (safe to
//     retry after a timeout);
//   - saving over someone else's newer edit is refused (409);
//   - a published post's URL is locked, because links to it would break.
// Editing a published post updates the live page and is audited with it.
export async function saveBlogPost(db, id, input = {}, { actorUserId = null, assets, origin, now = new Date() } = {}) {
  const postKey = postId(id);
  const fields = validateBlogPostInput(input);
  const revision = Number(input.revision ?? 0);
  if (!Number.isInteger(revision) || revision < 0) throw httpError('A valid revision is required.', 400);

  if ((await readManifest(assets, origin)).some((post) => post.slug === fields.slug)) {
    throw httpError(`A file-based post already uses /blog/${fields.slug}. Choose another URL.`, 409);
  }

  const existing = await findRow(db, postKey);
  const stamp = now.toISOString();
  if (existing
    && existing.slug === fields.slug
    && existing.title === fields.title
    && existing.summary === fields.summary
    && existing.body === fields.body) {
    return toBlogPostRecord(existing);
  }

  if (!existing) {
    if (revision !== 0) throw httpError('This post no longer exists. Copy your text, then start a new post.', 409);
    try {
      await db
        .prepare(
          `INSERT INTO blog_posts (id, slug, title, summary, body, status, revision, created_by_user_id, updated_by_user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'draft', 1, ?, ?, ?, ?)`
        )
        .bind(postKey, fields.slug, fields.title, fields.summary, fields.body, actorUserId, actorUserId, stamp, stamp)
        .run();
    } catch (error) {
      throw isUniqueSlugError(error) ? slugTaken(fields.slug) : error;
    }
    return toBlogPostRecord(await requireRow(db, postKey));
  }

  if (Number(existing.revision) !== revision) {
    throw httpError('This post was changed somewhere else. Reload it before saving.', 409);
  }
  if (existing.published_at && fields.slug !== existing.slug) {
    throw httpError("The URL can't change after a post has been published, because links to it would break.", 409);
  }
  const update = db
    .prepare(
      `UPDATE blog_posts SET slug = ?, title = ?, summary = ?, body = ?, revision = revision + 1, updated_by_user_id = ?, updated_at = ?
       WHERE id = ? AND revision = ?`
    )
    .bind(fields.slug, fields.title, fields.summary, fields.body, actorUserId, stamp, postKey, revision);
  const audit = existing.status === 'published' ? auditEvent('blog_post.update', { id: postKey, ...fields }, actorUserId, stamp) : null;
  let committed;
  try {
    committed = await commitChange(db, existing, update, audit);
  } catch (error) {
    throw isUniqueSlugError(error) ? slugTaken(fields.slug) : error;
  }
  if (!committed) throw httpError('This post was changed somewhere else. Reload it before saving.', 409);
  return toBlogPostRecord(await requireRow(db, postKey));
}

// Make a post public at /blog/<slug>. Publishing again is a no-op; the post
// keeps the date of its first publish.
export async function publishBlogPost(db, id, { actorUserId = null, now = new Date() } = {}) {
  const row = await requireRow(db, postId(id));
  if (row.status === 'published') return toBlogPostRecord(row);
  const stamp = now.toISOString();
  const publish = db
    .prepare(
      `UPDATE blog_posts SET status = 'published', post_date = ?, published_at = ?, updated_by_user_id = ?, updated_at = ?
       WHERE id = ? AND status = 'draft'`
    )
    .bind(row.post_date || pacificDate(now), row.published_at || stamp, actorUserId, stamp, row.id);
  if (!(await commitChange(db, row, publish, auditEvent('blog_post.publish', row, actorUserId, stamp)))) {
    // Something else changed it first. A post that is now published is the
    // same outcome (publishing again is a no-op); anything else needs a reload.
    const current = await requireRow(db, row.id);
    if (current.status === 'published') return toBlogPostRecord(current);
    throw httpError('This post was changed somewhere else. Reload it, then publish.', 409);
  }
  return toBlogPostRecord(await requireRow(db, row.id));
}

// Take a post off the blog (it becomes a draft again). Unpublishing a draft is
// a no-op.
export async function unpublishBlogPost(db, id, { actorUserId = null, now = new Date() } = {}) {
  const row = await requireRow(db, postId(id));
  if (row.status !== 'published') return toBlogPostRecord(row);
  const stamp = now.toISOString();
  const unpublish = db
    .prepare(
      `UPDATE blog_posts SET status = 'draft', updated_by_user_id = ?, updated_at = ?
       WHERE id = ? AND status = 'published'`
    )
    .bind(actorUserId, stamp, row.id);
  if (!(await commitChange(db, row, unpublish, auditEvent('blog_post.unpublish', row, actorUserId, stamp)))) {
    const current = await requireRow(db, row.id);
    if (current.status !== 'published') return toBlogPostRecord(current);
    throw httpError('This post was changed somewhere else. Reload it, then unpublish.', 409);
  }
  return toBlogPostRecord(await requireRow(db, row.id));
}
