import {
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  requireAdmin,
} from '../../../_lib/event-platform.js';
import { MESSAGE_IMAGE_MAX_BYTES, prepareMessageImage } from '../../../_lib/domain/message-draft.js';
import { sanitizeFilename } from '../../../_shared/submissions.js';

// POST /api/admin/message-drafts/images  (raw image body; Content-Type image/png|jpeg|gif)
// Admin-only. Stores an image for a message draft in R2 and returns its public
// /api/email-images/<name> URL. Names come from the image content, so
// uploading the same image again returns the same URL without storing a copy.
export async function onRequestPost(context) {
  return handleErrors(async () => {
    const { user } = await requireAdmin(context.request, context.env);
    const bucket = context.env.SUBMISSIONS_MEDIA;
    if (!bucket) {
      throw Object.assign(new Error('Upload storage is not configured.'), { status: 503 });
    }

    const { headers } = context.request;
    if (Number(headers.get('content-length') || 0) > MESSAGE_IMAGE_MAX_BYTES) {
      throw Object.assign(new Error(`Images must be ${MESSAGE_IMAGE_MAX_BYTES / 1024 / 1024}MB or smaller.`), { status: 400 });
    }

    const bytes = new Uint8Array(await context.request.arrayBuffer());
    const image = await prepareMessageImage({ contentType: headers.get('content-type'), bytes });

    const existing = await bucket.head(image.key);
    if (!existing) {
      await bucket.put(image.key, bytes, {
        httpMetadata: { contentType: image.contentType },
        customMetadata: {
          kind: 'email-image',
          originalFilename: sanitizeFilename(headers.get('x-filename') || 'email-image'),
          uploadedBy: user?.email || 'admin-token',
          uploadedAt: new Date().toISOString(),
        },
      });
    }

    return jsonResponse({ ok: true, url: image.url, name: image.name, reused: Boolean(existing) });
  });
}

export async function onRequest() {
  return methodNotAllowed(['POST']);
}
