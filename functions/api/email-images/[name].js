import { handleErrors, methodNotAllowed } from '../../_lib/event-platform.js';
import { messageImageKey } from '../../_lib/domain/message-draft.js';

function notFound() {
  return Object.assign(new Error('Image not found.'), { status: 404 });
}

// GET /api/email-images/<name>  (public)
// Serves images uploaded for message drafts. Email clients fetch these without a
// session, so the route is public, but it only resolves email-images/ names
// (see messageImageKey), never other objects in the bucket.
export async function onRequestGet(context) {
  return handleErrors(async () => {
    const key = messageImageKey(context.params.name);
    if (!key) throw notFound();
    const bucket = context.env.SUBMISSIONS_MEDIA;
    if (!bucket) {
      throw Object.assign(new Error('Upload storage is not configured.'), { status: 503 });
    }

    const object = await bucket.get(key);
    if (!object) throw notFound();

    const headers = new Headers();
    object.writeHttpMetadata?.(headers);
    if (object.httpEtag) headers.set('etag', object.httpEtag);
    headers.set('cache-control', 'public, max-age=31536000, immutable');
    headers.set('x-content-type-options', 'nosniff');
    return new Response(object.body, { headers });
  });
}

export async function onRequest() {
  return methodNotAllowed(['GET']);
}
