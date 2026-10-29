// MessageDraft message format: pure rendering of the plain-text message an
// organizer writes (the admin composer serializes its editor into this format)
// into safe email HTML. No database, no Resend, and no knowledge of drafts;
// functions/_lib/domain/message-draft.js wraps the result in the shared email
// template (functions/_shared/email-template.js).
//
// Formatting rules, kept deliberately small:
//   blank line                  -> new paragraph
//   single line break           -> <br>
//   lines starting "- " or "* " -> bullet list
//   lines starting "## "/"### " -> heading
//   a line "![alt](url)"        -> image (http(s) or root-relative url only),
//     optionally sized with "{width=N}" (clamped to MESSAGE_IMAGE_WIDTH)
//   [text](url)                 -> link (http(s) or root-relative url only)
//   **text**                    -> bold
//   bare http(s) URLs           -> links
// Everything else is escaped, so a message can never inject markup.

export const MESSAGE_LIMITS = Object.freeze({ subject: 150, heading: 150, message: 10000 });

// Resend fills these per recipient; see "Personalize your content" in the
// Resend broadcast docs. The admin composer inserts them as field chips.
export const MESSAGE_FIELDS = Object.freeze([
  { label: 'First name', token: '{{{contact.first_name|there}}}' },
  { label: 'Last name', token: '{{{contact.last_name}}}' },
  { label: 'Email', token: '{{{contact.email}}}' },
]);

// Image widths in email pixels: the email body is 600px wide with 24px
// padding, so 552px is full width.
export const MESSAGE_IMAGE_WIDTH = Object.freeze({ min: 80, max: 552 });

const BULLET = /^\s*[-*]\s+/;
const HEADING = /^\s*(#{2,3})\s+(.+)$/;
const IMAGE_LINE = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)(?:\{width=(\d{1,4})\})?\s*$/;
// One pass over a line: [text](url) links, **bold**, then bare http(s) URLs.
const INLINE = /\[([^\]\n]+)\]\(((?:https?:\/\/|\/(?!\/))[^)\s]*)\)|\*\*([^*\n]+?)\*\*|\bhttps?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]']/g;

export function messageBodyHtml(message) {
  return String(message || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n/)
    .map((block) => block.split('\n').filter((line) => line.trim()))
    .filter((lines) => lines.length)
    .map(renderBlock)
    .join('\n');
}

function lineKind(line) {
  const image = line.match(IMAGE_LINE);
  if (image && isImageSrc(image[2])) return 'image';
  if (HEADING.test(line)) return 'heading';
  return BULLET.test(line) ? 'bullet' : 'text';
}

function isImageSrc(src) {
  return /^https?:\/\//i.test(src) || /^\/(?!\/)/.test(src);
}

// A block can mix lines, bullets, and images ("Details:" followed by
// "- When: ..."), so split it into consecutive runs and render each run.
function renderBlock(lines) {
  const runs = [];
  for (const line of lines) {
    const kind = lineKind(line);
    const run = runs[runs.length - 1];
    if (run && run.kind === kind && kind !== 'image' && kind !== 'heading') run.lines.push(line);
    else runs.push({ kind, lines: [line] });
  }
  return runs.map(renderRun).join('\n');
}

function renderRun({ kind, lines }) {
  if (kind === 'image') {
    const [, alt, src, width] = lines[0].match(IMAGE_LINE);
    // The width attribute is what Outlook honors; the shared email styling
    // adds max-width:100% so a sized image still shrinks on small screens.
    const size = width ? ` width="${Math.min(MESSAGE_IMAGE_WIDTH.max, Math.max(MESSAGE_IMAGE_WIDTH.min, Number(width)))}"` : '';
    return `<p><img src="${escapeHtml(src)}" alt="${escapeHtml(alt.trim())}"${size}></p>`;
  }
  if (kind === 'heading') {
    const [, hashes, content] = lines[0].match(HEADING);
    const tag = hashes.length === 2 ? 'h2' : 'h3';
    return `<${tag}>${inline(content.trim())}</${tag}>`;
  }
  if (kind === 'bullet') {
    return `<ul>${lines.map((line) => `<li>${inline(line.replace(BULLET, '').trim())}</li>`).join('')}</ul>`;
  }
  return `<p>${lines.map((line) => inline(line.trim())).join('<br>')}</p>`;
}

function inline(text) {
  let html = '';
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const [whole, linkText, linkUrl, bold] = match;
    html += escapeHtml(text.slice(last, match.index));
    if (linkText !== undefined) html += `<a href="${escapeHtml(linkUrl)}">${escapeHtml(linkText)}</a>`;
    else if (bold !== undefined) html += `<strong>${escapeHtml(bold)}</strong>`;
    else html += `<a href="${escapeHtml(whole)}">${escapeHtml(whole)}</a>`;
    last = match.index + whole.length;
  }
  return html + escapeHtml(text.slice(last));
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
