// Message draft composer for the admin Email section (public/admin.html).
//
// The message box is the shared editor (admin-message-editor.js) with field
// chips enabled. "Start from" loads a published blog post (file-based or
// published from admin) into it, and the preview fills fields with a sample
// contact. "Goes to" shows the real audience (the configured Resend segment
// and its current size). Then:
//   - "Send me a test" emails it to the signed-in admin only;
//   - "Send now" sends it to the audience, after the admin types SEND;
//   - "create a Resend draft" hands it to Resend unsent, to schedule there.
// A send or draft names the segment that was shown, so the server refuses if
// it changed meanwhile, and carries one Idempotency-Key per request content,
// so repeating it never sends or creates twice.
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

// Sending reaches real people and can't be undone, so the admin types SEND.
export function isSendConfirmation(typed) {
  return String(typed ?? '').trim().toUpperCase() === 'SEND';
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
  // One Idempotency-Key per request (path and content). Keys are deliberately
  // never completed: repeating a send or draft replays the one that already
  // exists instead of sending or creating it again; editing gets a new key.
  const requestKeys = createMutationKeyStore();

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

  // --- Preview, test, send, and draft ----------------------------------------

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

  // A test needs a subject and a message within the limit; a send or a draft
  // also needs the audience on screen, since it names that segment.
  const ready = ({ audienceNeeded = true } = {}) => {
    if (!$('message-draft-subject').value.trim()) {
      setStatus('Add a subject line first.', true);
      return false;
    }
    if (tooLong()) return false;
    if (audienceNeeded && !audience) {
      setStatus('Check who it goes to first: the audience above has not loaded. Use Refresh.', true);
      return false;
    }
    return true;
  };

  // Run one request with its button disabled; the status line shows the result.
  const busy = async (button, pending, run) => {
    button.disabled = true;
    setStatus(pending);
    try {
      setStatus(await run());
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      button.disabled = false;
    }
  };

  const handOff = (path) => {
    const body = payload({ segmentId: audience.segmentId });
    return postJson(path, body, { 'Idempotency-Key': requestKeys.key('POST', path, JSON.stringify(body)) });
  };

  $('message-draft-test').addEventListener('click', () => {
    if (!ready({ audienceNeeded: false })) return;
    busy($('message-draft-test'), 'Sending you a test…', async () => {
      const data = await postJson('/api/admin/message-drafts/test', payload());
      return `Test sent to ${data.to}, with the fields filled in from your account. Nothing went to the audience.`;
    });
  });

  $('message-draft-send').addEventListener('click', () => {
    if (!ready()) return;
    const subject = $('message-draft-subject').value.trim();
    const goesTo = audienceLabel(audience);
    const typed = window.prompt(`Send "${subject}" to ${goesTo} now? It goes out right away and can't be undone.\n\nType SEND to confirm.`);
    if (typed === null) return;
    if (!isSendConfirmation(typed)) {
      setStatus('Not sent: type SEND to confirm.', true);
      return;
    }
    busy($('message-draft-send'), `Sending to ${goesTo}…`, async () => {
      const data = await handOff('/api/admin/message-drafts/send');
      return data.replayed
        ? `This email was already sent ("${data.name}"), so it was not sent again. Edit the message to send a new one.`
        : `Sent to ${goesTo}. Resend is delivering it now ("${data.name}").`;
    });
  });

  $('message-draft-create-draft').addEventListener('click', () => {
    if (!ready()) return;
    const subject = $('message-draft-subject').value.trim();
    const goesTo = audienceLabel(audience);
    if (!window.confirm(`Create a Resend draft of "${subject}" addressed to ${goesTo}? This only creates the draft; nothing is sent.`)) return;
    busy($('message-draft-create-draft'), 'Creating Resend draft…', async () => {
      const data = await handOff('/api/admin/message-drafts');
      return data.replayed
        ? `This draft is already in Resend ("${data.name}"); no duplicate was created. Edit the message to make a new draft.`
        : `Draft created in Resend as "${data.name}", addressed to ${goesTo}. Nothing was sent: review, schedule, or send it from Resend.`;
    });
  });

  loadPostList();
  loadAudience();
}

if (typeof document !== 'undefined' && document.getElementById('message-draft-editor')) initMessageDraft();
