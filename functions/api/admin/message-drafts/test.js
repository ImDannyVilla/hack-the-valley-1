import {
  getDb,
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  readJson,
  requireAdmin,
} from '../../../_lib/event-platform.js';
import { MessageDraft, sendTestEmail } from '../../../_lib/domain/message-draft.js';
import { emailBaseUrl } from '../../../_shared/email-template.js';

// POST /api/admin/message-drafts/test  { subject, heading?, message, postSlug? }
// Admin-only. Emails the draft to the signed-in admin's own address, with its
// fields filled in from their account, to check it before sending. It never
// goes to the audience.
export async function onRequestPost(context) {
  return handleErrors(async () => {
    const { user } = await requireAdmin(context.request, context.env);
    const { request, env } = context;

    const draft = await MessageDraft.fromInput(await readJson(request), { assets: env.ASSETS, origin: new URL(request.url).origin, db: getDb(env) });
    const result = await sendTestEmail(draft, {
      to: user?.email,
      name: user?.name,
      baseUrl: emailBaseUrl(request, env),
      env,
      fetcher: context.fetch || fetch,
    });
    return jsonResponse({ ok: true, ...result });
  });
}

export async function onRequest() {
  return methodNotAllowed(['POST']);
}
