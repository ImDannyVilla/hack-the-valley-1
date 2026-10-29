import {
  getDb,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  requireAdmin,
} from '../../../_lib/event-platform.js';
import { loadBlogPost } from '../../../_lib/domain/blog-post.js';

// GET /api/admin/message-drafts/blog-post?slug=<slug>
// Admin-only. Returns a published post's title and body HTML so a message
// draft can start from it. The composer converts the HTML into its editable
// message format; how posts are stored stays hidden inside BlogPost.
export async function onRequestGet(context) {
  return handleErrors(async () => {
    await requireAdmin(context.request, context.env);
    const url = new URL(context.request.url);
    const post = await loadBlogPost(context.env.ASSETS, url.searchParams.get('slug'), { origin: url.origin, db: getDb(context.env) });
    return jsonResponse({ ok: true, slug: post.slug, title: post.title, html: post.body() });
  });
}

export async function onRequest() {
  return methodNotAllowed(['GET']);
}
