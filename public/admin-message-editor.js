// Message editor shared by the admin email composer (admin-message-draft.js)
// and the blog editor (admin-blog-posts.js).
//
// The message box is a contenteditable editor: personalization fields show as
// chips, uploaded images as resizable previews, and loaded posts keep their
// headings, links, and bold text. The editor is serialized back to the
// plain-text message format the server renders
// (functions/_shared/message-format.js), so the server never sees editor HTML.
//
// Pure helpers are exported for tests; createMessageEditor only runs in a
// browser.

// Kept in sync with functions/_shared/message-format.js by tests.
export const MESSAGE_FIELDS = Object.freeze([
  { label: 'First name', token: '{{{contact.first_name|there}}}' },
  { label: 'Last name', token: '{{{contact.last_name}}}' },
  { label: 'Email', token: '{{{contact.email}}}' },
]);
export const IMAGE_WIDTH = Object.freeze({ min: 80, max: 552 });
export const IMAGE_SIZES = Object.freeze([
  { label: 'Small', width: 200 },
  { label: 'Medium', width: 360 },
  { label: 'Full', width: 552 },
]);
const UPLOAD_MAX_WIDTH = 1200;
const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
const FIELD_MIME = 'application/x-htv-field';
const ZWSP = '\u200B';
const HEADING_PREFIX = Object.freeze({ H1: '## ', H2: '## ', H3: '### ', H4: '### ' });
const LINE_BLOCKS = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'BLOCKQUOTE', 'SECTION']);
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'HR']);
const IMAGE_LINE = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)(?:\{width=(\d{1,4})\})?\s*$/;
const HEADING_LINE = /^\s*(#{2,3})\s+(.+)$/;
const INLINE = /(\{\{\{[^{}]+\}\}\})|\[([^\]\n]+)\]\(((?:https?:\/\/|\/(?!\/))[^)\s]*)\)|\*\*([^*\n]+?)\*\*/g;

export function clampImageWidth(value) {
  const width = Math.round(Number(value));
  if (!Number.isFinite(width)) return IMAGE_WIDTH.max;
  return Math.min(IMAGE_WIDTH.max, Math.max(IMAGE_WIDTH.min, width));
}

export function imageLine({ src, alt, width }) {
  const description = String(alt || '').replace(/[[\]\s]+/g, ' ').trim() || 'Image';
  return `![${description}](${src})${width ? `{width=${clampImageWidth(width)}}` : ''}`;
}

export function altFromFilename(name) {
  return String(name || '').replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/[[\]()]/g, '').trim() || 'Image';
}

// childNodes is a NodeList, which has no array methods; normalize once.
const children = (node) => Array.from(node?.childNodes || []);

function isSafeUrl(url) {
  return /^https?:\/\//i.test(url) || /^\/(?!\/)/.test(url);
}

function linkHref(node) {
  const href = String(node.getAttribute?.('href') ?? node.href ?? '').trim();
  return isSafeUrl(href) && !/[\s()]/.test(href) ? href : '';
}

// Keep surrounding spaces outside the markers: "a<b> bold</b>" -> "a **bold**".
function wrapInline(raw, open, close) {
  const [, lead, core, trail] = raw.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return core ? `${lead}${open}${core}${close}${trail}` : raw;
}

// Editor DOM -> message text. Chips become their tokens, image blocks become
// their own "![alt](url){width=N}" line, headings "## " lines, links
// [text](url), bold **text**, and <br>/blocks line breaks. Works on anything
// node-shaped so it can be tested without a DOM.
export function serializeEditor(root) {
  let out = '';
  const endLine = () => {
    if (out && !out.endsWith('\n')) out += '\n';
  };
  const capture = (node) => {
    const saved = out;
    out = '';
    walk(node);
    const inner = out;
    out = saved;
    return inner;
  };
  const walk = (node) => {
    for (const child of children(node)) {
      if (child.nodeType === 3) {
        out += String(child.nodeValue || '').replaceAll(ZWSP, '').replaceAll('\u00A0', ' ');
      } else if (child.nodeType !== 1) {
        continue;
      } else if (child.nodeName === 'BR') {
        out += '\n';
      } else if (child.dataset?.token) {
        out += child.dataset.token;
      } else if (child.dataset?.imageSrc) {
        endLine();
        out += `${imageLine({ src: child.dataset.imageSrc, alt: child.dataset.imageAlt, width: child.dataset.imageWidth })}\n`;
      } else if (HEADING_PREFIX[child.nodeName]) {
        const text = capture(child).replace(/\s*\n\s*/g, ' ').trim();
        endLine();
        if (text) out += `${HEADING_PREFIX[child.nodeName]}${text}\n`;
      } else if (child.nodeName === 'A') {
        const href = linkHref(child);
        const text = capture(child).replace(/\s*\n\s*/g, ' ').replace(/[[\]]/g, '');
        out += href ? wrapInline(text, '[', `](${href})`) : text;
      } else if (child.nodeName === 'STRONG' || child.nodeName === 'B') {
        out += wrapInline(capture(child), '**', '**');
      } else if (LINE_BLOCKS.has(child.nodeName)) {
        endLine();
        walk(child);
        endLine();
      } else {
        walk(child);
      }
    }
  };
  walk(root);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

// Published blog post body (parsed HTML) -> message text, so "Start from" can
// load a post into the editor. Keeps paragraphs, headings, lists, links, bold,
// and images; drops everything else to plain text.
export function htmlToMessage(root) {
  const blocks = [];
  const inline = (node) => {
    let text = '';
    for (const child of children(node)) {
      if (child.nodeType === 3) text += String(child.nodeValue || '').replace(/\s+/g, ' ');
      else if (child.nodeType !== 1 || SKIP.has(child.nodeName) || child.nodeName === 'IMG') continue;
      else if (child.nodeName === 'BR') text += '\n';
      else if (child.nodeName === 'A') {
        const href = linkHref(child);
        const label = inline(child).replace(/[[\]]/g, '');
        text += href ? wrapInline(label, '[', `](${href})`) : label;
      } else if (child.nodeName === 'STRONG' || child.nodeName === 'B') text += wrapInline(inline(child), '**', '**');
      else text += inline(child);
    }
    return text;
  };
  const images = (node) => {
    if (node.nodeName === 'IMG') return [node];
    return children(node).flatMap((child) => (child.nodeType === 1 ? images(child) : []));
  };
  const pushImages = (node) => {
    for (const img of images(node)) {
      const src = String(img.getAttribute?.('src') ?? img.src ?? '').trim();
      const width = Number(img.getAttribute?.('width') ?? img.width) || undefined;
      if (isSafeUrl(src)) blocks.push(imageLine({ src, alt: img.getAttribute?.('alt') ?? img.alt, width }));
    }
  };
  const pushText = (text, prefix = '') => {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length) blocks.push(prefix ? `${prefix}${lines.join(' ')}` : lines.join('\n'));
  };
  const walk = (node) => {
    for (const child of children(node)) {
      if (child.nodeType === 3) {
        pushText(String(child.nodeValue || '').replace(/\s+/g, ' '));
      } else if (child.nodeType !== 1 || SKIP.has(child.nodeName)) {
        continue;
      } else if (HEADING_PREFIX[child.nodeName]) {
        pushText(inline(child), HEADING_PREFIX[child.nodeName]);
      } else if (child.nodeName === 'UL' || child.nodeName === 'OL') {
        const items = children(child)
          .filter((item) => item.nodeName === 'LI')
          .map((item) => inline(item).replace(/\s*\n\s*/g, ' ').trim())
          .filter(Boolean);
        if (items.length) blocks.push(items.map((item) => `- ${item}`).join('\n'));
      } else if (child.nodeName === 'FIGURE' || child.nodeName === 'IMG') {
        pushImages(child);
        const caption = children(child).find((item) => item.nodeName === 'FIGCAPTION');
        if (caption) pushText(inline(caption));
      } else if (child.nodeName === 'P' || child.nodeName === 'BLOCKQUOTE') {
        pushText(inline(child));
        pushImages(child);
      } else {
        walk(child);
      }
    }
  };
  walk(root);
  return blocks.join('\n\n');
}

// Message text -> inline parts (text, field, link, bold). Known field tokens
// become field parts; unknown {{{...}}} tokens stay text.
export function inlineParts(text, fields = MESSAGE_FIELDS) {
  const byToken = new Map(fields.map((field) => [field.token, field]));
  const source = String(text || '');
  const parts = [];
  let last = 0;
  const pushText = (value) => {
    if (!value) return;
    const previous = parts[parts.length - 1];
    if (previous?.type === 'text') previous.value += value;
    else parts.push({ type: 'text', value });
  };
  for (const match of source.matchAll(INLINE)) {
    const [whole, token, linkText, linkUrl, bold] = match;
    pushText(source.slice(last, match.index));
    if (token) {
      const field = byToken.get(token);
      if (field) parts.push({ type: 'field', ...field });
      else pushText(token);
    } else if (linkText !== undefined) {
      parts.push({ type: 'link', text: linkText, href: linkUrl });
    } else {
      parts.push({ type: 'bold', text: bold });
    }
    last = match.index + whole.length;
  }
  pushText(source.slice(last));
  return parts;
}

// Message text -> editor blocks: images, headings, lines (with inline parts),
// and blank lines. The browser turns these into editor nodes.
export function messageBlocks(text, fields = MESSAGE_FIELDS) {
  return String(text || '').replace(/\r\n?/g, '\n').split('\n').map((line) => {
    const image = line.match(IMAGE_LINE);
    if (image && isSafeUrl(image[2])) {
      return { type: 'image', alt: image[1].trim(), src: image[2], width: image[3] ? clampImageWidth(image[3]) : IMAGE_WIDTH.max };
    }
    const heading = line.match(HEADING_LINE);
    if (heading) return { type: 'heading', level: heading[1].length, parts: inlineParts(heading[2].trim(), fields) };
    if (!line.trim()) return { type: 'blank' };
    return { type: 'line', parts: inlineParts(line, fields) };
  });
}

export async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function canvasBlob(canvas, type) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, 0.88));
}

// Email clients show PNG, JPEG, and GIF reliably (Outlook skips WebP), so
// resize to twice the email width and re-encode before upload. GIFs pass
// through untouched to keep animation.
async function emailReadyImage(file) {
  const bitmap = await createImageBitmap(file);
  if (file.type === 'image/gif') {
    const width = bitmap.width;
    bitmap.close?.();
    return { blob: file, width };
  }
  const scale = Math.min(1, UPLOAD_MAX_WIDTH / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  let blob = await canvasBlob(canvas, file.type === 'image/png' ? 'image/png' : 'image/jpeg');
  if (blob && blob.size > UPLOAD_MAX_BYTES && blob.type === 'image/png') blob = await canvasBlob(canvas, 'image/jpeg');
  if (!blob) throw new Error('Could not process that image.');
  return { blob, width: canvas.width };
}

// --- the editor ---------------------------------------------------------------

// Wire a contenteditable element as a message editor and return its message
// API. Field chips are optional: the blog editor passes allowFields: false,
// because personalized fields only work in emails.
export function createMessageEditor({ editor, fieldButtons = [], imageButton = null, imageInput = null, setStatus = () => {}, allowFields = true } = {}) {
  const fieldList = allowFields ? MESSAGE_FIELDS : [];
  const fields = new Map(fieldList.map((field) => [field.token, field]));
  let savedRange = null;

  const message = () => serializeEditor(editor);
  const refreshEmpty = () => {
    editor.dataset.empty = String(!message());
  };

  // Remember the caret so toolbar clicks insert where the organizer was typing.
  document.addEventListener('selectionchange', () => {
    const selection = document.getSelection();
    if (selection?.rangeCount && editor.contains(selection.anchorNode)) savedRange = selection.getRangeAt(0).cloneRange();
  });

  const caretRange = () => {
    if (savedRange && editor.contains(savedRange.startContainer)) return savedRange.cloneRange();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    return range;
  };

  // Never insert inside a chip or an image block.
  const outsideIslands = (range) => {
    const start = range.startContainer;
    const island = (start.nodeType === 1 ? start : start.parentElement)?.closest('[contenteditable="false"]');
    if (island && island !== editor && editor.contains(island)) {
      range.setStartAfter(island);
      range.collapse(true);
    }
    return range;
  };

  const insertNodes = (nodes, range) => {
    if (!nodes.length) return;
    const target = outsideIslands(range || caretRange());
    editor.focus({ preventScroll: true });
    target.deleteContents();
    const fragment = document.createDocumentFragment();
    nodes.forEach((node) => fragment.appendChild(node));
    const last = nodes[nodes.length - 1];
    target.insertNode(fragment);
    const after = document.createRange();
    after.setStartAfter(last);
    after.collapse(true);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(after);
    savedRange = after.cloneRange();
    refreshEmpty();
  };

  const fieldChip = (field) => {
    const chip = document.createElement('span');
    chip.className = 'msg-chip';
    chip.contentEditable = 'false';
    chip.dataset.token = field.token;
    chip.title = `${field.label}: filled in for each contact`;
    chip.textContent = field.label;
    return chip;
  };

  const insertField = (token, range) => {
    const field = fields.get(token);
    if (field) insertNodes([fieldChip(field), document.createTextNode(ZWSP)], range);
  };

  const applyImageWidth = (figure, value) => {
    const width = clampImageWidth(value);
    figure.dataset.imageWidth = String(width);
    figure.querySelector('img').style.width = `${width}px`;
    figure.querySelector('[data-image-width]').value = String(width);
    figure.querySelector('[data-image-width-label]').textContent = `${width}px`;
    figure.querySelectorAll('[data-image-size]').forEach((button) => {
      button.setAttribute('aria-pressed', String(Number(button.dataset.imageSize) === width));
    });
  };

  const imageBlock = ({ src, alt, width }) => {
    const figure = document.createElement('figure');
    figure.className = 'msg-image';
    figure.contentEditable = 'false';
    figure.dataset.imageSrc = src;
    figure.dataset.imageAlt = alt;
    const img = document.createElement('img');
    img.src = src;
    img.alt = alt;
    img.draggable = false;
    const tools = document.createElement('div');
    tools.className = 'msg-image-tools';
    tools.innerHTML = `${IMAGE_SIZES.map((size) => `<button type="button" data-image-size="${size.width}">${size.label}</button>`).join('')}
      <input type="range" data-image-width min="${IMAGE_WIDTH.min}" max="${IMAGE_WIDTH.max}" step="4" aria-label="Image width">
      <span data-image-width-label></span>
      <input type="text" data-image-alt maxlength="120" placeholder="Description" aria-label="Image description for screen readers">
      <button type="button" data-image-remove>Remove</button>`;
    tools.querySelector('[data-image-alt]').value = alt;
    figure.append(img, tools);
    applyImageWidth(figure, width);
    return figure;
  };

  const inlineNodes = (parts) => parts.map((part) => {
    if (part.type === 'field') return fieldChip(part);
    if (part.type === 'link') {
      const link = document.createElement('a');
      link.href = part.href;
      link.textContent = part.text;
      return link;
    }
    if (part.type === 'bold') {
      const strong = document.createElement('strong');
      strong.textContent = part.text;
      return strong;
    }
    return document.createTextNode(part.value);
  });

  // Message text -> editor nodes (used for pasting and for loading content).
  const nodesFromMessage = (text) => {
    const nodes = [];
    for (const block of messageBlocks(text, fieldList)) {
      if (block.type === 'image') {
        nodes.push(imageBlock(block));
      } else if (block.type === 'heading') {
        const heading = document.createElement(block.level === 2 ? 'h2' : 'h3');
        heading.append(...inlineNodes(block.parts));
        nodes.push(heading);
      } else if (block.type === 'blank') {
        nodes.push(document.createElement('br'));
      } else {
        nodes.push(...inlineNodes(block.parts), document.createElement('br'));
      }
    }
    if (nodes[nodes.length - 1]?.nodeName === 'BR') nodes.pop();
    return nodes;
  };

  const setMessage = (text) => {
    editor.replaceChildren(...nodesFromMessage(text));
    savedRange = null;
    refreshEmpty();
  };

  const uploadImage = async (file, range) => {
    if (!file?.type?.startsWith('image/')) {
      setStatus('Choose an image file.', true);
      return;
    }
    const at = (range || caretRange()).cloneRange();
    setStatus('Uploading image…');
    try {
      const image = await emailReadyImage(file);
      const data = await readJson(await fetch('/api/admin/message-drafts/images', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': image.blob.type, 'X-Filename': encodeURIComponent(file.name || 'image') },
        body: image.blob,
      }));
      const block = imageBlock({ src: data.url, alt: altFromFilename(file.name), width: Math.min(image.width, IMAGE_WIDTH.max) });
      insertNodes([block, document.createTextNode(ZWSP)], editor.contains(at.startContainer) ? at : null);
      setStatus('Image added. Resize it with Small, Medium, Full, or the slider.');
    } catch (error) {
      setStatus(error.message, true);
    }
  };

  const rangeFromPoint = (x, y) => {
    let range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(x, y);
    } else if (document.caretPositionFromPoint) {
      const position = document.caretPositionFromPoint(x, y);
      if (position) {
        range = document.createRange();
        range.setStart(position.offsetNode, position.offset);
        range.collapse(true);
      }
    }
    return range && editor.contains(range.startContainer) ? range : null;
  };

  // --- Insert bar --------------------------------------------------------------

  for (const button of allowFields ? fieldButtons : []) {
    const token = button.dataset.messageField;
    button.addEventListener('click', () => insertField(token));
    button.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData(FIELD_MIME, token);
      event.dataTransfer.setData('text/plain', token);
      event.dataTransfer.effectAllowed = 'copy';
    });
  }
  imageButton?.addEventListener('click', () => imageInput?.click());
  imageInput?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) uploadImage(file);
  });

  // --- Editor behavior ---------------------------------------------------------

  // Enter adds a line break (<br>) rather than a nested <div>. In a heading,
  // the new line starts after the heading instead of inside it.
  editor.addEventListener('keydown', (event) => {
    if (event.target !== editor || event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    const selection = document.getSelection();
    const anchor = selection?.anchorNode;
    const heading = (anchor?.nodeType === 1 ? anchor : anchor?.parentElement)?.closest('h2, h3');
    if (heading && editor.contains(heading)) {
      const after = document.createRange();
      after.setStartAfter(heading);
      after.collapse(true);
      selection.removeAllRanges();
      selection.addRange(after);
    }
    document.execCommand('insertLineBreak');
  });

  // Paste as plain text (known tokens become chips), or upload a pasted image.
  editor.addEventListener('paste', (event) => {
    if (event.target.closest?.('.msg-image')) return;
    event.preventDefault();
    const image = [...(event.clipboardData?.files || [])].find((file) => file.type.startsWith('image/'));
    if (image) uploadImage(image);
    else insertNodes(nodesFromMessage(event.clipboardData?.getData('text/plain') || ''));
  });

  // Drop a field button or an image file where it should go.
  const droppable = (event) => {
    const types = [...(event.dataTransfer?.types || [])];
    return (allowFields && types.includes(FIELD_MIME)) || types.includes('Files');
  };
  editor.addEventListener('dragover', (event) => {
    if (!droppable(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    editor.classList.add('msg-drop-target');
  });
  editor.addEventListener('dragleave', (event) => {
    if (!editor.contains(event.relatedTarget)) editor.classList.remove('msg-drop-target');
  });
  editor.addEventListener('drop', (event) => {
    editor.classList.remove('msg-drop-target');
    const token = allowFields ? event.dataTransfer?.getData(FIELD_MIME) : '';
    const file = [...(event.dataTransfer?.files || [])].find((item) => item.type.startsWith('image/'));
    if (!token && !file) return;
    event.preventDefault();
    const range = rangeFromPoint(event.clientX, event.clientY);
    if (token) insertField(token, range);
    else uploadImage(file, range);
  });

  // Image tools: size presets, width slider, description, remove.
  editor.addEventListener('input', (event) => {
    const figure = event.target.closest?.('.msg-image');
    if (figure && event.target.matches('[data-image-width]')) applyImageWidth(figure, event.target.value);
    if (figure && event.target.matches('[data-image-alt]')) figure.dataset.imageAlt = event.target.value;
    refreshEmpty();
  });
  editor.addEventListener('click', (event) => {
    const button = event.target.closest?.('button');
    const figure = button?.closest('.msg-image');
    if (!figure || !editor.contains(figure)) return;
    if (button.dataset.imageSize) applyImageWidth(figure, button.dataset.imageSize);
    if (button.hasAttribute('data-image-remove')) {
      figure.remove();
      refreshEmpty();
      setStatus('Image removed.');
    }
  });

  refreshEmpty();

  return {
    message,
    setMessage,
    // Load published post HTML (as returned by the server) for editing.
    setHtml(html) {
      setMessage(htmlToMessage(new DOMParser().parseFromString(String(html || ''), 'text/html').body));
    },
    clear() {
      setMessage('');
    },
  };
}
