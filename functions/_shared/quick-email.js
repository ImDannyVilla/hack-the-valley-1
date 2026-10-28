// Pure rendering for admin quick emails: turns the plain-text message an
// organizer types into safe email HTML. No database and no Resend calls. The
// route wraps the result in the shared broadcast chrome
// (functions/_shared/blog-broadcast.js) so quick emails look like blog emails.
//
// Formatting rules, kept deliberately small:
//   blank line                  -> new paragraph
//   single line break           -> <br>
//   lines starting "- " or "* " -> bullet list
//   lines starting "## "/"### " -> heading
//   a line "![alt](url)"        -> image (http(s) or root-relative url only),
//     optionally sized with "{width=N}" (clamped to EMAIL_IMAGE_WIDTH)
//   [text](url)                 -> link (http(s) or root-relative url only)
//   **text**                    -> bold
//   bare http(s) URLs           -> links
// Everything else is escaped, so a message can never inject markup.

export const QUICK_EMAIL_LIMITS = Object.freeze({ subject: 150, heading: 150, message: 10000 });

// Resend fills these per recipient; see "Personalize your content" in the
// Resend broadcast docs. The admin form inserts them from buttons.
export const QUICK_EMAIL_FIELDS = Object.freeze([
  { label: 'First name', token: '{{{contact.first_name|there}}}' },
  { label: 'Last name', token: '{{{contact.last_name}}}' },
  { label: 'Email', token: '{{{contact.email}}}' },
]);

// Image widths in email pixels: the email body is 600px wide with 24px
// padding, so 552px is full width.
export const EMAIL_IMAGE_WIDTH = Object.freeze({ min: 80, max: 552 });

const BULLET = /^\s*[-*]\s+/;
const HEADING = /^\s*(#{2,3})\s+(.+)$/;
const IMAGE_LINE = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)(?:\{width=(\d{1,4})\})?\s*$/;
// One pass over a line: [text](url) links, **bold**, then bare http(s) URLs.
const INLINE = /\[([^\]\n]+)\]\(((?:https?:\/\/|\/(?!\/))[^)\s]*)\)|\*\*([^*\n]+?)\*\*|\bhttps?:\/\/[^\s<>"]*[^\s<>".,;:!?)\]']/g;

export function quickEmailBodyHtml(message) {
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
    const size = width ? ` width="${Math.min(EMAIL_IMAGE_WIDTH.max, Math.max(EMAIL_IMAGE_WIDTH.min, Number(width)))}"` : '';
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

// --- uploaded images -------------------------------------------------------
//
// Email clients fetch images over plain public URLs, so uploads live in R2
// under email-images/ and are served by /api/email-images/<name>. That route
// only ever resolves names that match EMAIL_IMAGE_NAME, so it cannot be used
// to read anything else in the bucket. Only email-safe formats are accepted;
// the admin form converts other images (e.g. WebP) to JPEG before upload.

export const EMAIL_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const EMAIL_IMAGE_TYPES = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' });
const EMAIL_IMAGE_NAME = /^img_[a-f0-9]{16}\.(png|jpg|gif)$/;

export function prepareEmailImageUpload({ contentType, bytes, id } = {}) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  const ext = EMAIL_IMAGE_TYPES[type];
  if (!ext) {
    throw Object.assign(new Error('Images must be PNG, JPEG, or GIF.'), { status: 400 });
  }
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || new ArrayBuffer(0));
  if (!data.byteLength) {
    throw Object.assign(new Error('The image file is empty.'), { status: 400 });
  }
  if (data.byteLength > EMAIL_IMAGE_MAX_BYTES) {
    throw Object.assign(new Error(`Images must be ${EMAIL_IMAGE_MAX_BYTES / 1024 / 1024}MB or smaller.`), { status: 400 });
  }
  if (sniffImageType(data) !== type) {
    throw Object.assign(new Error('The file contents are not a valid PNG, JPEG, or GIF image.'), { status: 400 });
  }
  const name = `${id}.${ext}`;
  if (!EMAIL_IMAGE_NAME.test(name)) {
    throw Object.assign(new Error('Invalid image id.'), { status: 500 });
  }
  return { name, key: emailImageKey(name), contentType: type, url: `/api/email-images/${name}` };
}

// Returns the R2 key for a public image name, or null for anything else.
export function emailImageKey(name) {
  return EMAIL_IMAGE_NAME.test(String(name || '')) ? `email-images/${name}` : null;
}

function sniffImageType(data) {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return 'image/gif';
  return null;
}
