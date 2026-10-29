import {
  getDb,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  readJson,
  requireAdmin,
} from '../../../_lib/event-platform.js';
import {
  getBlogPostRecord,
  publishBlogPost,
  saveBlogPost,
  unpublishBlogPost,
} from '../../../_lib/domain/blog-post.js';

// GET  /api/admin/blog-posts/:id            the post, for editing
// PUT  /api/admin/blog-posts/:id            { revision, slug, title, summary, body } create or save
// POST /api/admin/blog-posts/:id/publish    make it public at /blog/<slug>
// POST /api/admin/blog-posts/:id/unpublish  take it off the blog
// Admin-only. The rules (revisions, locked URLs, audit) live in BlogPost.
export async function onRequestGet(context) {
  return handleErrors(async () => {
    if (context.params.action) return methodNotAllowed(['POST']);
    await requireAdmin(context.request, context.env);
    return jsonResponse({ ok: true, post: await getBlogPostRecord(getDb(context.env), context.params.id) });
  });
}

export async function onRequestPut(context) {
  return handleErrors(async () => {
    if (context.params.action) return methodNotAllowed(['POST']);
    const { user } = await requireAdmin(context.request, context.env);
    const post = await saveBlogPost(getDb(context.env), context.params.id, await readJson(context.request), {
      actorUserId: user?.id || null,
      assets: context.env.ASSETS,
      origin: new URL(context.request.url).origin,
    });
    return jsonResponse({ ok: true, post });
  });
}

export async function onRequestPost(context) {
  return handleErrors(async () => {
    const { action } = context.params;
    if (action !== 'publish' && action !== 'unpublish') return methodNotAllowed(['GET', 'PUT']);
    const { user } = await requireAdmin(context.request, context.env);
    const change = action === 'publish' ? publishBlogPost : unpublishBlogPost;
    const post = await change(getDb(context.env), context.params.id, { actorUserId: user?.id || null });
    return jsonResponse({ ok: true, post });
  });
}

export async function onRequest() {
  return methodNotAllowed(['GET', 'PUT', 'POST']);
}
