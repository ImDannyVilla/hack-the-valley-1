// Message draft composer for the admin Email section (public/admin.html).
//
// The message box is the shared editor (admin-message-editor.js) with field
// chips enabled. "Start from" loads a published blog post (file-based or
// published from admin) into it, the preview fills fields with a sample
// contact, and "Create Resend draft" sends one Idempotency-Key per draft
// content to POST /api/admin/message-drafts. "Goes to" shows the real
// audience (the configured Resend segment and its current size); creating a
// draft names that segment, so the server refuses if it changed meanwhile.
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

// "General: 1,204 contacts (1,180 subscribed)". A sent broadcast skips
// unsubscribed contacts, so that count is shown when it differs.
export function audienceLabel({ name, contactCount = 0, subscribedCount = contactCount } = {}) {
  const count = (n) => Number(n).toLocaleString('en-US');
  const contacts = `${count(contactCount)} contact${contactCount === 1 ? '' : 's'}`;
  return subscribedCount === contactCount ? `${name}: ${contacts}` : `${name}: ${contacts} (${count(subscribedCount)} subscribed)`;
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
  const audienceLine = $('message-draft-audience');
  let postSlug = '';
  let audience = null;
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

  // --- Goes to: the real audience a draft is addressed to ---------------------

  const loadAudience = async () => {
    audience = null;
    audienceLine.textContent = 'Loading the audience…';
    try {
      const data = await readJson(await fetch('/api/admin/message-drafts/audience', { credentials: 'same-origin', headers: { Accept: 'application/json' } }));
      audience = data.audience;
      audienceLine.textContent = audienceLabel(audience);
    } catch (error) {
      audienceLine.textContent = `Couldn't load the audience: ${error.message}`;
    }
  };

  $('message-draft-audience-refresh').addEventListener('click', () => loadAudience());
  // The audience needs a signed-in admin and changes as people sign up; refresh
  // it whenever the Email section opens.
  document.querySelectorAll('[data-admin-nav="email"]').forEach((control) => control.addEventListener('click', () => loadAudience()));

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
    if (!audience) {
      setStatus('Check who the draft goes to first: the audience above has not loaded. Use Refresh.', true);
      return;
    }
    const goesTo = audienceLabel(audience);
    if (!window.confirm(`Create a Resend draft of "${subject}" addressed to ${goesTo}? Nothing will be sent or scheduled from HTV admin.`)) return;

    const button = $('message-draft-create-draft');
    button.disabled = true;
    setStatus('Creating Resend draft…');
    try {
      const body = payload({ segmentId: audience.segmentId });
      const key = draftKeys.key('POST', '/api/admin/message-drafts', JSON.stringify(body));
      const data = await postJson('/api/admin/message-drafts', body, { 'Idempotency-Key': key });
      setStatus(data.replayed
        ? `This draft is already in Resend ("${data.name}"); no duplicate was created. Edit the message to make a new draft.`
        : `Draft created in Resend as "${data.name}", addressed to ${goesTo}. Nothing was sent: review it and send it from Resend.`);
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  loadPostList();
  loadAudience();
}

if (typeof document !== 'undefined' && document.getElementById('message-draft-editor')) initMessageDraft();
