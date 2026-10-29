// Email template: pure helpers that wrap already-rendered message HTML in the
// HTV email chrome (header, events CTA, reply prompt, unsubscribe footer). No
// database, no Resend calls, and no knowledge of how messages or posts are
// stored. Used by the MessageDraft domain object
// (functions/_lib/domain/message-draft.js).

// Rewrite root-relative src/href ("/images/...") to absolute URLs so they
// resolve in an email client. Leaves protocol-relative and absolute URLs alone.
export function absolutizeUrls(html, baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) return String(html || '');
  return String(html || '').replace(/(\s(?:src|href))="\/(?!\/)/g, `$1="${base}/`);
}

// Email clients ignore <style>/Tailwind, so any sizing the web page relied on
// is gone. Inline a width constraint on every image (otherwise full-resolution
// screenshots overflow the email width) and lightly style figure captions.
export function styleContentForEmail(html) {
  return String(html || '')
    .replace(
      /<img\b(?![^>]*\sstyle=)([^>]*)>/gi,
      '<img style="max-width:100%;height:auto;display:block;margin:16px auto;border-radius:8px;border:1px solid #e2e8f0;"$1>'
    )
    .replace(
      /<figcaption\b(?![^>]*\sstyle=)([^>]*)>/gi,
      '<figcaption style="font-size:13px;color:#64748b;text-align:center;margin-top:6px;"$1>'
    );
}

export const DEFAULT_BLOG_SUBMISSION_PROMPT = 'Want to highlight something on the Hack the Valley blog? Reply to this email with the project, demo, or story we should feature.';

// Build an email-friendly HTML document. Email clients ignore <style>/Tailwind,
// so the chrome uses inline styles; the post body keeps its semantic tags.
// The CTA block is platform-owned on purpose: every email gets the same event
// + submission prompts, even one started from a post that forgets them.
export function buildEmailHtml({ title, contentHtml, postUrl, eventsUrl, submissionPrompt = DEFAULT_BLOG_SUBMISSION_PROMPT } = {}) {
  const safeTitle = escapeHtml(title || 'Hack the Valley');
  const body = styleContentForEmail(contentHtml);
  const safeSubmissionPrompt = escapeHtml(submissionPrompt || DEFAULT_BLOG_SUBMISSION_PROMPT);
  const wrapperStyle = 'font-family:Arial,Helvetica,sans-serif;color:#0f172a;line-height:1.6;';
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f1f5f9;">
  <div style="max-width:600px;margin:0 auto;padding:24px;background:#ffffff;${wrapperStyle}">
    <div style="border-bottom:2px solid #06b6d4;padding-bottom:12px;margin-bottom:24px;">
      <span style="font-size:14px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#2563eb;">Hack the Valley</span>
    </div>
    <h1 style="font-size:26px;font-weight:800;margin:0 0 20px;color:#0f172a;">${safeTitle}</h1>
    <div style="font-size:16px;color:#334155;">
      ${body}
    </div>
    <div style="margin:32px 0;padding:24px;background:#0f172a;border-radius:12px;">
      <p style="margin:0 0 14px;color:#e2e8f0;font-size:16px;text-align:center;">Don't miss the next one.</p>
      <p style="margin:0 0 18px;text-align:center;"><a href="${escapeAttr(eventsUrl || '#')}" style="display:inline-block;background:#06b6d4;color:#0f172a;font-weight:bold;text-decoration:none;padding:14px 28px;border-radius:8px;font-size:16px;">See upcoming events</a></p>
      <div style="border-top:1px solid #334155;margin-top:18px;padding-top:18px;">
        <p style="margin:0;color:#e2e8f0;font-size:15px;text-align:center;"><strong>Have something to share?</strong><br>${safeSubmissionPrompt}</p>
      </div>
    </div>
    <p style="font-size:13px;color:#64748b;">
      ${postUrl ? `Read this on the web: <a href="${escapeAttr(postUrl)}" style="color:#2563eb;">${escapeHtml(postUrl)}</a><br>` : ''}
      You're receiving this because you joined the Hack the Valley updates list.
      <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="color:#64748b;">Unsubscribe</a>.
    </p>
  </div>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}
