import {
  handleErrors,
  jsonResponse,
  methodNotAllowed,
  readJson,
  requireAdmin,
} from '../../_lib/event-platform.js';
import { absolutizeUrls, buildBroadcastEmailHtml } from '../../_shared/blog-broadcast.js';
import { QUICK_EMAIL_LIMITS, quickEmailBodyHtml } from '../../_shared/quick-email.js';
import { createDraftEmail } from '../../_lib/domain/blog-broadcast.js';

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

function baseUrl(request, env) {
  return String(env.SITE_BASE_URL || new URL(request.url).origin).replace(/\/+$/, '');
}

function text(value, label, max, { required = false } = {}) {
  const trimmed = String(value || '').trim();
  if (required && !trimmed) throw httpError(`${label} is required.`, 400);
  if (trimmed.length > max) throw httpError(`${label} must be ${max} characters or fewer.`, 400);
  return trimmed;
}

// POST /api/admin/quick-email  { subject, heading?, message, dryRun? }
// Admin-only. Renders a one-off announcement in the same email chrome as blog
// blasts and creates a Resend draft. Like blog emails, there is deliberately no
// send/schedule mode: recipients are reviewed and the send happens in Resend.
export async function onRequestPost(context) {
  return handleErrors(async () => {
    await requireAdmin(context.request, context.env);
    const { request, env } = context;

    const input = await readJson(request);
    const subject = text(input.subject, 'Subject', QUICK_EMAIL_LIMITS.subject, { required: true });
    const heading = text(input.heading, 'Heading', QUICK_EMAIL_LIMITS.heading);
    const message = text(input.message, 'Message', QUICK_EMAIL_LIMITS.message, { required: true });

    // Uploaded images are referenced root-relative (/api/email-images/...);
    // email clients need absolute URLs.
    const base = baseUrl(request, env);
    const html = buildBroadcastEmailHtml({
      title: heading || subject,
      contentHtml: absolutizeUrls(quickEmailBodyHtml(message), base),
      eventsUrl: `${base}/events`,
    });

    if (input.dryRun) {
      return jsonResponse({ ok: true, dryRun: true, subject, html });
    }

    const result = await createDraftEmail({
      subject,
      name: `Quick email: ${subject}`,
      html,
      env,
      fetcher: context.fetch || fetch,
    });

    return jsonResponse({ ok: true, subject, ...result });
  });
}

export async function onRequest() {
  return methodNotAllowed(['POST']);
}
