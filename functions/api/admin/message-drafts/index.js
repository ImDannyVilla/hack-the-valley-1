import {
  getDb,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  readJson,
  requireAdmin,
} from '../../../_lib/event-platform.js';
import { MessageDraft, createResendDraft } from '../../../_lib/domain/message-draft.js';

function baseUrl(request, env) {
  return String(env.SITE_BASE_URL || new URL(request.url).origin).replace(/\/+$/, '');
}

// POST /api/admin/message-drafts  { subject, heading?, message, postSlug?, segmentId, dryRun? }
// Admin-only. dryRun returns the rendered email for preview. Otherwise creates
// a Resend draft, at most once per Idempotency-Key header, for the audience
// the admin was shown (segmentId, from GET /api/admin/message-drafts/audience).
// There is deliberately no send/schedule mode: the send happens in Resend.
export async function onRequestPost(context) {
  return handleErrors(async () => {
    const { user } = await requireAdmin(context.request, context.env);
    const { request, env } = context;

    const input = await readJson(request);
    const draft = await MessageDraft.fromInput(input, { assets: env.ASSETS, origin: new URL(request.url).origin, db: getDb(env) });
    const base = baseUrl(request, env);

    if (input.dryRun) {
      return jsonResponse({ ok: true, dryRun: true, subject: draft.subject, html: draft.toEmailHtml({ baseUrl: base }) });
    }

    const result = await createResendDraft(getDb(env), draft, {
      actorUserId: user?.id,
      key: request.headers.get('Idempotency-Key'),
      segmentId: String(input.segmentId || '').trim(),
      baseUrl: base,
      env,
      fetcher: context.fetch || fetch,
    });
    return jsonResponse({ ok: true, subject: draft.subject, ...result });
  });
}

export async function onRequest() {
  return methodNotAllowed(['POST']);
}
