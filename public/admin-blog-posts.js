// Blog editor for the admin Blog section (public/admin.html): write, preview,
// publish, and unpublish posts on hackthevalley.org/blog.
//
// The post body uses the shared message editor (admin-message-editor.js)
// without field chips, since personalized fields only work in emails. Each new
// post gets its id here and every save names the revision it edited (PUT
// /api/admin/blog-posts/:id), so a retried save never duplicates a post and an
// out-of-date save is refused instead of overwriting someone else's edit.
// Publish makes a post public right away. File-based posts are listed
// read-only because they live in the repo.
//
// Pure helpers are exported for tests; the DOM wiring only runs in a browser.

import { createMessageEditor, readJson } from './admin-message-editor.js';

// "Hack Hours is back!" -> "hack-hours-is-back"
export function slugify(title) {
  return String(title || '')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
}

export function newPostId() {
  return `post_${crypto.randomUUID().replaceAll('-', '')}`;
}

// Human label for a post's state in the list and editor header.
export function postStateLabel(post) {
  if (!post?.revision) return 'Not saved yet';
  if (post.status === 'published') return post.postDate ? `Published · ${post.postDate}` : 'Published';
  return post.publishedAt ? 'Unpublished (draft)' : 'Draft';
}

async function sendJson(method, path, body) {
  return readJson(await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

function initBlogPosts() {
  const $ = (id) => document.getElementById(id);
  const status = $('blog-status');
  let post = null;
  let slugEdited = false;
  let savedSnapshot = '';

  const setStatus = (message, error = false) => {
    status.className = `text-sm ${error ? 'text-red-300' : 'text-slate-300'}`;
    status.textContent = message;
  };

  const editor = createMessageEditor({
    editor: $('blog-body-editor'),
    imageButton: $('blog-image-button'),
    imageInput: $('blog-image-file'),
    setStatus,
    allowFields: false,
  });

  const form = () => ({
    title: $('blog-title').value.trim(),
    slug: $('blog-slug').value.trim(),
    summary: $('blog-summary').value.trim(),
    body: editor.message(),
  });
  const snapshot = () => JSON.stringify(form());
  const isDirty = () => snapshot() !== savedSnapshot;
  const announceChange = () => document.dispatchEvent(new CustomEvent('htv:blog-posts-changed'));

  const renderState = () => {
    const published = post?.status === 'published';
    $('blog-editor-heading').textContent = post?.revision ? (post.title || 'Untitled post') : 'New post';
    $('blog-editor-state').textContent = postStateLabel(post);
    $('blog-publish').classList.toggle('hidden', published);
    $('blog-unpublish').classList.toggle('hidden', !published);
    $('blog-view').classList.toggle('hidden', !published);
    if (published) $('blog-view').href = post.url;
    const locked = Boolean(post?.publishedAt);
    $('blog-slug').readOnly = locked;
    $('blog-slug-note').textContent = locked
      ? 'The URL is locked because this post has been published; links to it would break.'
      : 'Fills in from the title until you edit it.';
  };

  const startNew = () => {
    post = { id: newPostId(), revision: 0, status: 'draft', publishedAt: null };
    $('blog-title').value = '';
    $('blog-slug').value = '';
    $('blog-summary').value = '';
    editor.clear();
    $('blog-preview-frame').srcdoc = '';
    slugEdited = false;
    savedSnapshot = snapshot();
    renderState();
    setStatus('New post. Write it, preview it, then publish.');
  };

  const loadPost = (record) => {
    post = record;
    $('blog-title').value = record.title;
    $('blog-slug').value = record.slug;
    $('blog-summary').value = record.summary || '';
    editor.setMessage(record.body);
    slugEdited = true;
    savedSnapshot = snapshot();
    renderState();
  };

  const confirmDiscard = () => !isDirty() || window.confirm('Discard your unsaved changes to this post?');

  // --- The list --------------------------------------------------------------

  const cell = (text, className = 'py-2 pr-4') => {
    const td = document.createElement('td');
    td.className = className;
    td.textContent = text;
    return td;
  };

  const viewLink = (url) => {
    const link = document.createElement('a');
    link.href = url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.className = 'text-bc-cyan underline mr-3';
    link.textContent = 'View';
    return link;
  };

  const renderList = ({ posts = [], filePosts = [] }) => {
    const table = document.createElement('table');
    table.className = 'w-full text-left';
    table.innerHTML = '<thead><tr class="text-xs uppercase tracking-wide text-slate-500"><th class="py-2 pr-4">Title</th><th class="py-2 pr-4">Status</th><th class="py-2 pr-4">Date</th><th class="py-2"></th></tr></thead>';
    const body = document.createElement('tbody');
    for (const item of posts) {
      const row = document.createElement('tr');
      row.className = 'border-t border-slate-700';
      row.append(cell(item.title), cell(postStateLabel(item).split(' · ')[0]), cell(item.postDate || '—'));
      const actions = document.createElement('td');
      actions.className = 'py-2 text-right whitespace-nowrap';
      if (item.status === 'published') actions.append(viewLink(item.url));
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'rounded-full border border-slate-600 px-3 py-1 text-xs font-bold hover:border-bc-cyan';
      edit.textContent = 'Edit';
      edit.dataset.blogEdit = item.id;
      actions.append(edit);
      row.append(actions);
      body.append(row);
    }
    for (const item of filePosts) {
      const row = document.createElement('tr');
      row.className = 'border-t border-slate-700 text-slate-400';
      row.append(cell(item.title), cell('Published (file)'), cell(item.date || '—'));
      const actions = document.createElement('td');
      actions.className = 'py-2 text-right whitespace-nowrap text-xs';
      actions.append(viewLink(`/blog/${encodeURIComponent(item.slug)}`), 'Edit in the repo');
      row.append(actions);
      body.append(row);
    }
    table.append(body);
    $('blog-post-list').replaceChildren(table);
    if (!posts.length && !filePosts.length) $('blog-post-list').textContent = 'No posts yet.';
  };

  const loadList = async () => {
    try {
      renderList(await sendJson('GET', '/api/admin/blog-posts'));
    } catch (error) {
      $('blog-post-list').textContent = `Could not load posts: ${error.message}`;
    }
  };

  $('blog-post-list').addEventListener('click', async (event) => {
    const id = event.target.closest?.('[data-blog-edit]')?.dataset.blogEdit;
    if (!id || !confirmDiscard()) return;
    try {
      loadPost((await sendJson('GET', `/api/admin/blog-posts/${encodeURIComponent(id)}`)).post);
      setStatus('Post loaded.');
      $('blog-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  // --- Editing ---------------------------------------------------------------

  $('blog-title').addEventListener('input', () => {
    if (!slugEdited && !post?.publishedAt) $('blog-slug').value = slugify($('blog-title').value);
  });
  $('blog-slug').addEventListener('input', () => {
    slugEdited = true;
  });

  const save = async () => {
    const data = await sendJson('PUT', `/api/admin/blog-posts/${post.id}`, { ...form(), revision: post.revision });
    post = data.post;
    savedSnapshot = snapshot();
    renderState();
    await loadList();
    if (post.status === 'published') announceChange();
    return post;
  };

  $('blog-new-post').addEventListener('click', () => {
    if (confirmDiscard()) startNew();
  });

  $('blog-save').addEventListener('click', async () => {
    if (post.revision && !isDirty()) {
      setStatus('No changes to save.');
      return;
    }
    if (post.status === 'published' && !window.confirm(`This post is live. Saving updates hackthevalley.org${post.url} right away.`)) return;
    setStatus('Saving…');
    try {
      await save();
      setStatus(post.status === 'published' ? 'Saved. The live post is updated.' : 'Draft saved. Only admins can see it.');
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  $('blog-preview').addEventListener('click', async () => {
    setStatus('Rendering preview…');
    try {
      const { title, summary, body } = form();
      const data = await sendJson('POST', '/api/admin/blog-posts/preview', { title, summary, body });
      $('blog-preview-frame').srcdoc = data.html;
      setStatus('Preview ready. This is how the post will look on the site.');
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  $('blog-publish').addEventListener('click', async () => {
    const { title, slug } = form();
    if (!window.confirm(`Publish "${title || 'this post'}"? It will be public at hackthevalley.org/blog/${slug} right away.`)) return;
    setStatus('Publishing…');
    try {
      if (!post.revision || isDirty()) await save();
      post = (await sendJson('POST', `/api/admin/blog-posts/${post.id}/publish`)).post;
      renderState();
      await loadList();
      announceChange();
      setStatus(`Published. It's live at ${post.url}.`);
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  $('blog-unpublish').addEventListener('click', async () => {
    if (!window.confirm(`Unpublish "${post.title}"? It will come off the blog right away. You can publish it again later.`)) return;
    setStatus('Unpublishing…');
    try {
      post = (await sendJson('POST', `/api/admin/blog-posts/${post.id}/unpublish`)).post;
      renderState();
      await loadList();
      announceChange();
      setStatus('Unpublished. The post is a draft again.');
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  // The list needs a signed-in admin; refresh it whenever the Blog section opens.
  document.querySelectorAll('[data-admin-nav="blog"]').forEach((control) => control.addEventListener('click', () => loadList()));

  startNew();
  loadList();
}

if (typeof document !== 'undefined' && document.getElementById('blog-body-editor')) initBlogPosts();
