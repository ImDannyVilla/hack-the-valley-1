import {
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  requireAdmin,
} from '../../../_lib/event-platform.js';
import { EMAIL_IMAGE_MAX_BYTES, prepareEmailImageUpload } from '../../../_shared/quick-email.js';
import { randomId, sanitizeFilename } from '../../../_shared/submissions.js';

// POST /api/admin/quick-email/images  (raw image body; Content-Type image/png|jpeg|gif)
// Admin-only. Stores an image for a quick email in R2 and returns the public
// /api/email-images/<name> URL the message references.
export async function onRequestPost(context) {
  return handleErrors(async () => {
    const { user } = await requireAdmin(context.request, context.env);
    const bucket = context.env.SUBMISSIONS_MEDIA;
    if (!bucket) {
      throw Object.assign(new Error('Upload storage is not configured.'), { status: 503 });
    }

    const { headers } = context.request;
    if (Number(headers.get('content-length') || 0) > EMAIL_IMAGE_MAX_BYTES) {
      throw Object.assign(new Error(`Images must be ${EMAIL_IMAGE_MAX_BYTES / 1024 / 1024}MB or smaller.`), { status: 400 });
    }

    const bytes = new Uint8Array(await context.request.arrayBuffer());
    const upload = prepareEmailImageUpload({
      contentType: headers.get('content-type'),
      bytes,
      id: randomId('img'),
    });

    await bucket.put(upload.key, bytes, {
      httpMetadata: { contentType: upload.contentType },
      customMetadata: {
        kind: 'email-image',
        originalFilename: sanitizeFilename(headers.get('x-filename') || 'email-image'),
        uploadedBy: user?.email || 'admin-token',
        uploadedAt: new Date().toISOString(),
      },
    });

    return jsonResponse({ ok: true, url: upload.url, name: upload.name });
  });
}

export async function onRequest() {
  return methodNotAllowed(['POST']);
}
