import {
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  requireAdmin,
} from '../../../_lib/event-platform.js';
import { fetchDraftAudience } from '../../../_shared/resend-broadcasts.js';

// GET /api/admin/message-drafts/audience
// Admin-only. Who a new email draft is addressed to: the Resend segment in
// RESEND_ALL_CONTACTS_SEGMENT_ID with its current contact count, shown in the
// composer before a draft is created. Creating a draft names this segment.
export async function onRequestGet(context) {
  return handleErrors(async () => {
    await requireAdmin(context.request, context.env);
    const audience = await fetchDraftAudience({ env: context.env, fetcher: context.fetch || fetch });
    return jsonResponse({ ok: true, audience });
  });
}

export async function onRequest() {
  return methodNotAllowed(['GET']);
}
