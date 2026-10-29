// Message draft composer for the admin Email section (public/admin.html).
//
// The message box is the shared editor (admin-message-editor.js) with field
// chips enabled. "Start from" loads a published blog post (file-based or
// published from admin) into it, the preview fills fields with a sample
// contact, and "Create Resend draft" sends one Idempotency-Key per draft
// content to POST /api/admin/message-drafts.
//
// Pure helpers are exported for tests; the DOM wiring only runs in a browser.

import { createMutationKeyStore } from './admin-idempotency.js';
import { createMessageEditor, readJson } from './admin-message-editor.js';

const MESSAGE_MAX = 10000;

// The preview shows the email as this contact would see it; the real email
// keeps the tokens for Resend to fill in.
export const PREVIEW_CONTACT = Object.freeze({ first_name: 'Alex', last_name: 'Rivera', email: 'alex.rivera@example.com' });

const CONTACT_TOKEN = /\{\{\{contact\.([a-z_]+)(?:\|([^}]*))?\}\}\}/g;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Preview only: fill contact fields with a sample contact so the preview reads
// like a real inbox. Unknown fields fall back to the token's fallback text.
export function previewWithSampleContact(html, contact = PREVIEW_CONTACT) {
  return String(html || '').replace(CONTACT_TOKEN, (token, field, fallback = '') => escapeHtml(contact[field] ?? fallback));
}

async function postJson(path, body, headers = {}) {
  return readJson(await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
  }));
}

function initMessageDraft() {
  const $ = (id) => document.getElementById(id);
  const status = $('message-draft-status');
  const startSelect = $('message-draft-start');
  const postNote = $('message-draft-post-note');
  let postSlug = '';
  // One Idempotency-Key per draft content. Keys are deliberately never
  // completed: re-submitting the same content replays the draft that already
  // exists instead of creating a duplicate; editing the content gets a new key.
  const draftKeys = createMutationKeyStore();

  const setStatus = (message, error = false) => {
    status.className = `text-sm ${error ? 'text-red-300' : 'text-slate-300'}`;
    status.textContent = message;
  };

  const editor = createMessageEditor({
    editor: $('message-draft-editor'),
    fieldButtons: document.querySelectorAll('[data-message-field]'),
    imageButton: $('message-draft-image-button'),
    imageInput: $('message-draft-image-file'),
    setStatus,
  });

  // --- Start from: blank or a published blog post ---------------------------

  const setPost = (slug, title = '') => {
    postSlug = slug;
    postNote.classList.toggle('hidden', !slug);
    postNote.textContent = slug ? `Started from “${title}”. The email ends with a link to read the post on the web.` : '';
  };

  const loadPostList = async () => {
    try {
      const data = await readJson(await fetch('/api/blog/posts', { headers: { Accept: 'application/json' } }));
      const posts = Array.isArray(data.posts) ? data.posts : [];
      startSelect.querySelector('optgroup')?.remove();
      if (!posts.length) return;
      const group = document.createElement('optgroup');
      group.label = 'Published blog posts';
      for (const post of posts) {
        const option = document.createElement('option');
        option.value = post.slug;
        option.textContent = post.date ? `${post.title || post.slug} (${post.date})` : (post.title || post.slug);
        group.append(option);
      }
      startSelect.append(group);
      startSelect.value = postSlug;
    } catch {
      // Blank messages still work without the post list.
    }
  };

  startSelect.addEventListener('change', async () => {
    const slug = startSelect.value;
    if (editor.message() && !window.confirm('Replace the current message?')) {
      startSelect.value = postSlug;
      return;
    }
    if (!slug) {
      editor.clear();
      setPost('');
      setStatus('Started a blank message.');
      return;
    }
    setStatus('Loading post…');
    try {
      const data = await readJson(await fetch(`/api/admin/message-drafts/blog-post?slug=${encodeURIComponent(slug)}`, { credentials: 'same-origin' }));
      editor.setHtml(data.html);
      if (!$('message-draft-subject').value.trim()) $('message-draft-subject').value = data.title || '';
      $('message-draft-heading').value = data.title || '';
      setPost(data.slug, data.title || data.slug);
      setStatus('Post loaded. Edit anything below, then preview.');
    } catch (error) {
      startSelect.value = postSlug;
      setStatus(error.message, true);
    }
  });

  // Posts published from the Blog section show up here without a reload.
  document.addEventListener('htv:blog-posts-changed', () => loadPostList());

  // --- Preview and draft -----------------------------------------------------

  const payload = (extra = {}) => ({
    subject: $('message-draft-subject').value.trim(),
    heading: $('message-draft-heading').value.trim(),
    message: editor.message(),
    ...(postSlug ? { postSlug } : {}),
    ...extra,
  });
  const tooLong = () => {
    if (editor.message().length <= MESSAGE_MAX) return false;
    setStatus(`The message is too long (limit ${MESSAGE_MAX} characters).`, true);
    return true;
  };

  $('message-draft-preview').addEventListener('click', async () => {
    if (tooLong()) return;
    setStatus('Rendering preview…');
    try {
      const data = await postJson('/api/admin/message-drafts', payload({ dryRun: true }));
      $('message-draft-preview-frame').srcdoc = previewWithSampleContact(data.html);
      const { first_name: first, last_name: last, email } = PREVIEW_CONTACT;
      setStatus(`Preview ready — subject: "${data.subject}". Shown as ${first} ${last} (${email}) would see it; each contact gets their own details. Nothing has been sent.`);
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  $('message-draft-create-draft').addEventListener('click', async () => {
    const subject = $('message-draft-subject').value.trim();
    if (!subject) {
      setStatus('Add a subject line first.', true);
      return;
    }
    if (tooLong()) return;
    if (!window.confirm(`Create a Resend draft for "${subject}"? Nothing will be sent or scheduled from HTV admin.`)) return;

    const button = $('message-draft-create-draft');
    button.disabled = true;
    setStatus('Creating Resend draft…');
    try {
      const body = payload();
      const key = draftKeys.key('POST', '/api/admin/message-drafts', JSON.stringify(body));
      const data = await postJson('/api/admin/message-drafts', body, { 'Idempotency-Key': key });
      const segment = data.segmentName || data.segmentId || 'placeholder segment';
      setStatus(data.replayed
        ? `This draft already exists in Resend (broadcast ${data.broadcastId}); no duplicate was created. Edit the message to create a new draft.`
        : `Draft created for "${data.subject}". Resend broadcast ${data.broadcastId}. Recipient placeholder: ${segment}. Review/change recipients in Resend before sending.`);
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  loadPostList();
}

if (typeof document !== 'undefined' && document.getElementById('message-draft-editor')) initMessageDraft();
