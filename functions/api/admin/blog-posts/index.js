import {
  getDb,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  requireAdmin,
} from '../../../_lib/event-platform.js';
import { listBlogPostRecords, listPublishedBlogPosts } from '../../../_lib/domain/blog-post.js';

// GET /api/admin/blog-posts
// Admin-only. Admin posts (drafts and published) for editing, plus the
// file-based posts, which are read-only here because they live in the repo.
export async function onRequestGet(context) {
  return handleErrors(async () => {
    await requireAdmin(context.request, context.env);
    const { env } = context;
    const origin = new URL(context.request.url).origin;
    const [posts, published] = await Promise.all([
      listBlogPostRecords(getDb(env)),
      listPublishedBlogPosts({ assets: env.ASSETS, origin }),
    ]);
    return jsonResponse({ ok: true, posts, filePosts: published.filter((post) => post.source === 'file') });
  });
}

export async function onRequest() {
  return methodNotAllowed(['GET']);
}
