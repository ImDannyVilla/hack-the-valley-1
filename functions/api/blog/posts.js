import { getDb, handleErrors, jsonResponse, methodNotAllowed } from '../../_lib/event-platform.js';
import { listPublishedBlogPosts } from '../../_lib/domain/blog-post.js';

// GET /api/blog/posts  (public)
// Every published post, newest first: the file-based posts in posts.json plus
// posts published from /admin. Drafts are never listed. Used by /blog/ and by
// "Start from" in the admin email composer.
export async function onRequestGet(context) {
  return handleErrors(async () => {
    const posts = await listPublishedBlogPosts({
      assets: context.env.ASSETS,
      origin: new URL(context.request.url).origin,
      db: getDb(context.env),
    });
    return jsonResponse({ ok: true, posts });
  });
}

export async function onRequest() {
  return methodNotAllowed(['GET']);
}
