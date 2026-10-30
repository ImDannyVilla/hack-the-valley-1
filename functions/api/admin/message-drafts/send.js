import {
  getDb,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  readJson,
  requireAdmin,
} from '../../../_lib/event-platform.js';
import { MessageDraft, sendMessageDraft } from '../../../_lib/domain/message-draft.js';
import { emailBaseUrl } from '../../../_shared/email-template.js';

// POST /api/admin/message-drafts/send  { subject, heading?, message, postSlug?, segmentId }
// Admin-only, with an Idempotency-Key header. Sends the email right away to
// the audience the admin was shown (segmentId, from GET
// /api/admin/message-drafts/audience); the composer asks the admin to type
// SEND first. A retry with the same key never sends again, and every send is
// audited (message_draft.send).
export async function onRequestPost(context) {
  return handleErrors(async () => {
    const { user } = await requireAdmin(context.request, context.env);
    const { request, env } = context;

    const input = await readJson(request);
    const draft = await MessageDraft.fromInput(input, { assets: env.ASSETS, origin: new URL(request.url).origin, db: getDb(env) });
    const result = await sendMessageDraft(getDb(env), draft, {
      actorUserId: user?.id,
      key: request.headers.get('Idempotency-Key'),
      segmentId: String(input.segmentId || '').trim(),
      baseUrl: emailBaseUrl(request, env),
      env,
      fetcher: context.fetch || fetch,
    });
    return jsonResponse({ ok: true, subject: draft.subject, ...result });
  });
}

export async function onRequest() {
  return methodNotAllowed(['POST']);
}
