import {
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  readJson,
  requireAdmin,
} from '../../../_lib/event-platform.js';
import { previewBlogPost } from '../../../_lib/domain/blog-post.js';
import { absolutizeUrls } from '../../../_shared/email-template.js';

// POST /api/admin/blog-posts/preview  { title?, summary?, body }
// Admin-only. Returns the public page HTML for unsaved editor content, so the
// preview shows exactly what Publish would put on the site. Saves nothing.
export async function onRequestPost(context) {
  return handleErrors(async () => {
    await requireAdmin(context.request, context.env);
    const input = await readJson(context.request);
    const html = absolutizeUrls(previewBlogPost(input), new URL(context.request.url).origin);
    return jsonResponse({ ok: true, html });
  });
}

export async function onRequest() {
  return methodNotAllowed(['POST']);
}
