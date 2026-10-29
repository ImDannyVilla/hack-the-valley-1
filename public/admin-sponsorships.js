import { switchAdminAccount } from './admin-session.js';
import { createMutationKeyStore } from './admin-idempotency.js';

export { createMutationKeyStore };

const API = '/api/admin/sponsorships';
const STATUSES = {
  not_contacted: 'Not contacted', contacted: 'Contacted', followup: 'Followup',
  interest: 'Interest', negotiating: 'Negotiating', lost: 'Lost', committed: 'Committed', paid: 'Paid',
};

export function telephoneHref(value) {
  const match = String(value ?? '').trim().match(/^(\+?[\d\s().-]+?)(?:\s*(?:ext\.?|extension|x|#)\s*(\d+))?$/i);
  if (!match) return null;
  const number = match[1].replace(/[\s().-]/g, '');
  if (!/^\+?\d+$/.test(number)) return null;
  return `tel:${number}${match[2] ? `;ext=${match[2]}` : ''}`;
}

export function parseMoney(value) {
  const raw = String(value).trim();
  if (!raw) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error('Enter a non-negative amount with at most two decimal places.');
  const [dollars, cents = ''] = raw.split('.');
  const result = Number(dollars) * 100 + Number(cents.padEnd(2, '0'));
  if (!Number.isSafeInteger(result)) throw new Error('This amount is too large.');
  return result;
}


// A save includes the visible UI transition, not just the successful HTTP write.
// Keep an acknowledged result until refresh/detail rendering also succeeds.
export function createSaveSession(makeKey = () => crypto.randomUUID()) {
  const attempts = new Map();
  const session = {
    hasAcknowledgedResult() { return [...attempts.values()].some(attempt => Object.hasOwn(attempt, 'result')); },
    async mutate(method, path, payload, send) {
      const identity = JSON.stringify([method, path, payload]);
      if (!attempts.has(identity)) attempts.set(identity, { key: makeKey() });
      const attempt = attempts.get(identity);
      if (!Object.hasOwn(attempt, 'result')) attempt.result = await send(attempt.key);
      return attempt.result;
    },
    async run(action) {
      const result = await action(session);
      attempts.clear();
      return result;
    },
  };
  return session;
}

export function reviewLatestDraft(record, draft, latest, savedFields = latest) {
  const differences = Object.entries(draft)
    .filter(([field, value]) => String(value ?? '') !== String(savedFields[field] ?? ''))
    .map(([field, value]) => ({ field, draft: String(value ?? ''), saved: String(savedFields[field] ?? '') }));
  return { differences, accept() { Object.assign(record, latest); } };
}

export function filterMotions(rows, { campaign = '', owner = '', status = '', overdue = false, search = '' } = {}) {
  const needle = search.toLowerCase().trim();
  return rows.filter(row => (!campaign || row.campaign_id === campaign)
    && (!owner || row.owner_user_id === owner)
    && (!status || row.status === status)
    && (!overdue || Boolean(row.overdue))
    && (!needle || [row.business_name, row.contact_name, row.email, row.notes, row.next_action, row.owner_name]
      .some(value => String(value || '').toLowerCase().includes(needle))));
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const phoneLink = (value, missing = 'Not provided') => {
  const phone = String(value ?? '').trim();
  const href = telephoneHref(phone);
  return href ? `<a class="contact-link" href="${escapeHtml(href)}" aria-label="Call ${escapeHtml(phone)}">${escapeHtml(phone)}</a>` : escapeHtml(phone || missing);
};
const money = cents => cents == null ? 'Not set' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
const moneyInput = cents => cents == null ? '' : (cents / 100).toFixed(2);
const dateLabel = value => value ? new Date(`${value.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'No date set';
const timeLabel = value => value ? new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }) : '';
const initials = value => String(value || '?').split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase();
const badge = status => `<span class="status-badge status-${escapeHtml(status)}">${escapeHtml(STATUSES[status] || status)}</span>`;
const option = (value, label, selected) => `<option value="${escapeHtml(value)}"${String(value) === String(selected) ? ' selected' : ''}>${escapeHtml(label)}</option>`;
const field = (name, label, value = '', { type = 'text', full = false, required = false, extra = '' } = {}) => `<label${full ? ' class="full"' : ''}><span>${label}</span><input name="${name}" type="${type}" value="${escapeHtml(value)}"${required ? ' required' : ''} ${extra}></label>`;
const textarea = (name, label, value = '', extra = '') => `<label class="full"><span>${label}</span><textarea name="${name}" ${extra}>${escapeHtml(value)}</textarea></label>`;
const select = (name, label, options, full = false) => `<label${full ? ' class="full"' : ''}><span>${label}</span><select name="${name}">${options}</select></label>`;
const empty = (title, description, action = '') => `<div class="empty-state"><h3>${title}</h3><p>${description}</p>${action}</div>`;
const state = { tab: 'outreach', user: null, contacts: [], campaigns: [], motions: [], owners: [], events: [], reminders: [], livePreviews: null, previewMode: false, selectedCampaign: '', detail: null };
const keys = createMutationKeyStore();
const formSessions = new WeakMap();
const conflictForms = new WeakMap();
const $ = selector => document.querySelector(selector);

async function request(path, { method = 'GET', body, upload, headers = {}, fingerprint, session } = {}) {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  const payloadIdentity = fingerprint ?? serialized ?? '';
  const mutation = method !== 'GET';
  if (mutation && session) return session.mutate(method, path, payloadIdentity, key => request(path, {
    method, body, upload, headers: { ...headers, 'Idempotency-Key': key }, fingerprint,
  }));
  const requestHeaders = { Accept: 'application/json', ...headers };
  if (serialized !== undefined) requestHeaders['Content-Type'] = 'application/json';
  if (mutation && !requestHeaders['Idempotency-Key']) requestHeaders['Idempotency-Key'] = keys.key(method, path, payloadIdentity);
  let response;
  try {
    response = await fetch(`${API}${path}`, { method, credentials: 'same-origin', headers: requestHeaders, body: upload ?? serialized, cache: 'no-store' });
  } catch {
    throw new Error('Connection interrupted. Your draft is still here. Try Save again to safely retry.');
  }
  let data;
  try { data = await response.json(); } catch { throw new Error('The server returned an unreadable response. Your draft is still here; retry the same save.'); }
  if (response.status === 401) {
    if (!mutation && !$('#editor')?.open) window.location.assign('/login/?next=/admin-sponsorships');
    throw new Error('Your session expired. Sign in in another tab, then retry this draft.');
  }
  if (!response.ok) {
    const error = new Error(data.error || data.message || 'This change could not be saved.');
    error.status = response.status;
    if (response.status === 403) error.message = 'Admin access is required. An active admin or super admin role is needed to use this workspace.';
    if (response.status === 409) error.message += ' Your draft has been kept. Review the latest saved version before applying your changes.';
    throw error;
  }
  if (mutation && !headers['Idempotency-Key']) keys.complete(method, path, payloadIdentity);
  return data;
}

async function list(path) {
  const items = [];
  for (let offset = 0; ; offset += 100) {
    const result = await request(`${path}?limit=100&offset=${offset}`);
    const page = result.items || [];
    items.push(...page);
    if (page.length < 100 || items.length >= (result.count ?? items.length)) return items;
  }
}

function notice(message, error = false, editor = false) {
  const node = $(editor ? '#editor-status' : '#global-status');
  node.textContent = message;
  node.classList.toggle('error', error);
  node.hidden = !message;
}

async function saving(form, action) {
  if (form.dataset.saving) return;
  form.dataset.saving = 'true';
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  notice('Saving…', false, true);
  if (!formSessions.has(form)) formSessions.set(form, createSaveSession());
  const session = formSessions.get(form);
  try { await session.run(action); }
  catch (error) {
    notice(session.hasAcknowledgedResult() ? `Your change was saved, but the workspace could not refresh. Retry the same save to finish safely. ${error.message}` : error.message, true, true);
    if (error.status === 409 && conflictForms.has(form)) showConflictReview(form);
  }
  finally { delete form.dataset.saving; buttons.forEach(button => { button.disabled = false; }); }
}

function configureConflict(form, path, record, savedFields = row => row) {
  conflictForms.set(form, { path, record, savedFields });
}

function showConflictReview(form) {
  const config = conflictForms.get(form);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'button secondary small';
  button.textContent = 'Review latest saved version';
  $('#editor-status').append(document.createElement('br'), button);
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const response = await request(config.path);
      const latest = response.item;
      const draft = Object.fromEntries(new FormData(form));
      for (const input of form.querySelectorAll('input[type="checkbox"]')) draft[input.name] = input.checked ? 'Yes' : 'No';
      for (const input of form.querySelectorAll('input[type="file"]')) draft[input.name] = input.files[0]?.name || 'No file selected';
      const review = reviewLatestDraft(config.record, draft, latest, config.savedFields(latest));
      form.querySelector('.conflict-review')?.remove();
      const panel = document.createElement('section');
      panel.className = 'conflict-review';
      panel.innerHTML = `<h3>Review changes before saving</h3><p>The current saved version is revision ${escapeHtml(latest.revision)}. Your draft remains in the form above. Saving it will replace the fields shown below.</p>${review.differences.length ? `<div class="table-scroll"><table><thead><tr><th>Field</th><th>Latest saved value</th><th>Your draft</th></tr></thead><tbody>${review.differences.map(change => `<tr><td>${escapeHtml(form.elements.namedItem(change.field)?.closest('label')?.querySelector('span')?.textContent || change.field)}</td><td>${escapeHtml(change.saved || 'Empty')}</td><td>${escapeHtml(change.draft || 'Empty')}</td></tr>`).join('')}</tbody></table></div>` : '<p>The visible fields match; another saved change advanced this record’s revision.</p>'}<button type="button" class="button primary small">Use latest revision & keep my draft</button>`;
      form.append(panel);
      panel.querySelector('button').addEventListener('click', () => {
        review.accept();
        panel.remove();
        notice('Your draft is ready against the reviewed version. Review the form, then click Save to apply it.', false, true);
      });
      notice('Latest version loaded. Review the comparison below your draft before continuing.', false, true);
      panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (error) { notice(error.message, true, true); showConflictReview(form); }
    finally { button.disabled = false; }
  });
}

async function loadData() {
  const [contacts, campaigns, motions, ownerResult, eventResult] = await Promise.all([
    list('/contacts'), list('/campaigns'), list('/motions'), request('/owners'), request('/events'),
  ]);
  Object.assign(state, { contacts, campaigns, motions, owners: ownerResult.items || [], events: eventResult.items || [] });
  fillFilters();
  render();
}

function fillFilters() {
  const campaign = $('#campaign-filter').value || state.selectedCampaign;
  $('#campaign-filter').innerHTML = option('', 'All campaigns', campaign) + state.campaigns.map(row => option(row.id, `${row.name}${row.archived_at ? ' · Archived' : ''}`, campaign)).join('');
  const owner = $('#owner-filter').value;
  const ownerRows = [...state.owners];
  for (const motion of state.motions) {
    if (!ownerRows.some(row => row.id === motion.owner_user_id)) ownerRows.push({ id: motion.owner_user_id, name: `${motion.owner_name || motion.owner_email || 'Former owner'} · Reassign` });
  }
  $('#owner-filter').innerHTML = option('', 'All owners', owner) + ownerRows.map(row => option(row.id, row.name || row.display_name || row.email, owner)).join('');
  const status = $('#status-filter').value;
  $('#status-filter').innerHTML = option('', 'All statuses', status) + Object.entries(STATUSES).map(([value, label]) => option(value, label, status)).join('');
}

function currentFilters() {
  return { campaign: $('#campaign-filter').value, owner: $('#owner-filter').value, status: $('#status-filter').value, overdue: $('#overdue-filter').checked, search: $('#search').value };
}

function renderSummary() {
  const campaign = $('#campaign-filter').value;
  const rows = state.motions.filter(row => !campaign || row.campaign_id === campaign);
  const current = rows.filter(row => ['committed', 'paid'].includes(row.status));
  const committed = current.reduce((sum, row) => sum + Number(row.committed_cents || 0), 0);
  const received = current.reduce((sum, row) => sum + Number(row.received_cents || 0), 0);
  const overdue = rows.filter(row => row.overdue).length;
  $('#summary').innerHTML = [
    ['', 'Prospects in view', rows.length, campaign ? escapeHtml(state.campaigns.find(row => row.id === campaign)?.name || '') : 'Across all campaigns', '↗'],
    ['overdue', 'Overdue follow-ups', overdue, overdue ? 'A conversation to pick back up' : 'You’re all caught up', '◷'],
    ['cash', 'Cash committed', money(committed), `${current.length} current sponsorship${current.length === 1 ? '' : 's'}`, '↗'],
    ['received', 'Cash received', money(received), `${money(Math.max(0, committed - received))} outstanding`, '✓'],
  ].map(([style, label, value, note, symbol]) => `<article class="summary-card ${style}"><span class="metric-decoration" aria-hidden="true">${symbol}</span><span class="metric-label">${label}</span><strong class="metric">${value}</strong><span class="metric-note">${note}</span></article>`).join('');
  $('#outreach-count').textContent = state.motions.length;
}

function businessCell(row) {
  return `<div class="business-line"><span class="business-avatar" aria-hidden="true">${escapeHtml(initials(row.business_name))}</span><div><button class="business-name" data-open-motion="${escapeHtml(row.id)}">${escapeHtml(row.business_name)}</button><span class="subtext">${escapeHtml(row.campaign_name)}${row.campaign_archived_at ? ' · Archived' : ''}</span></div></div>`;
}

function outreachTable(rows) {
  if (!rows.length) return empty('Room for the next connection', 'No prospects match these filters. Clear a filter or add a prospect.', '<button class="button secondary" data-add-motion>+ Add prospect</button>');
  return `<div class="table-scroll"><table><thead><tr><th scope="col">Business</th><th scope="col">Primary contact</th><th scope="col">HTV owner</th><th scope="col">Status</th><th scope="col">Latest activity / notes</th><th scope="col">Next action</th><th scope="col">Follow-up</th><th scope="col"><span class="sr-only">Edit</span></th></tr></thead><tbody>${rows.map(row => `<tr${row.overdue ? ' class="overdue-row"' : ''}>
    <td class="business-cell">${businessCell(row)}</td>
    <td class="contact-cell">${escapeHtml(row.contact_name || 'No contact yet')}${row.email ? `<a href="mailto:${escapeHtml(row.email)}">${escapeHtml(row.email)}</a>` : '<span class="subtext">No email yet</span>'}</td>
    <td class="owner-cell"><span class="owner-initial" aria-hidden="true">${escapeHtml(initials(row.owner_name || row.owner_email))}</span>${escapeHtml(row.owner_name || row.owner_email || 'Unknown owner')}${row.owner_active === false || row.owner_active === 0 ? '<span class="reassign-label">Needs reassignment</span>' : ''}</td>
    <td>${badge(row.status)}</td>
    <td class="notes-cell"><span class="truncate-lines">${escapeHtml(row.latest_activity || row.notes || 'No activity yet')}</span></td>
    <td class="next-cell">${escapeHtml(row.next_action || 'Set the next step')}${row.follow_up_completed_at ? '<span class="completed-label">✓ Completed</span>' : ''}</td>
    <td class="date-cell">${escapeHtml(dateLabel(row.follow_up_on))}${row.overdue ? '<span class="overdue-label">● Overdue</span>' : ''}</td>
    <td><button class="button quiet small" data-open-motion="${escapeHtml(row.id)}" aria-label="Edit ${escapeHtml(row.business_name)}">↗</button></td>
  </tr>`).join('')}</tbody></table></div>`;
}

function contactTable(rows) {
  if (!rows.length) return empty('Your relationships start here', 'Add a business once, then reuse it for every campaign.', '<button class="button secondary" data-add-contact>+ Add contact</button>');
  return `<div class="table-scroll"><table><thead><tr><th scope="col">Business</th><th scope="col">Primary contact</th><th scope="col">Email</th><th scope="col">Phone</th><th scope="col">Campaign history</th><th scope="col">Actions</th></tr></thead><tbody>${rows.map(row => {
    const motions = state.motions.filter(motion => motion.contact_id === row.id);
    return `<tr><td class="business-cell"><button class="business-name" data-edit-contact="${escapeHtml(row.id)}">${escapeHtml(row.business_name)}</button><span class="subtext">${escapeHtml(row.website || '')}</span></td><td>${escapeHtml(row.contact_name || 'Not set')}</td><td>${row.email ? `<a href="mailto:${escapeHtml(row.email)}">${escapeHtml(row.email)}</a>` : '—'}</td><td>${phoneLink(row.phone, '—')}</td><td>${motions.length ? motions.map(motion => `<span class="subtext">${escapeHtml(motion.campaign_name)} · ${escapeHtml(STATUSES[motion.status])}</span>`).join('') : '<span class="subtext">Not in a campaign yet</span>'}</td><td><div class="button-row"><button class="button secondary small" data-use-contact="${escapeHtml(row.id)}">Add to campaign</button><button class="button quiet small" data-edit-contact="${escapeHtml(row.id)}">Edit</button></div></td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function sponsorshipTable(rows) {
  if (!rows.length) return empty('Commitments live here', 'Mark a prospect Committed to start tracking cash, in-kind support, and sponsor assets.');
  return `<div class="table-scroll"><table><thead><tr><th scope="col">Sponsor</th><th scope="col">Status</th><th scope="col">Cash committed</th><th scope="col">Cash received</th><th scope="col">Outstanding</th><th scope="col">In-kind support</th><th scope="col">Logo</th><th scope="col">Details</th></tr></thead><tbody>${rows.map(row => `<tr><td class="business-cell">${businessCell(row)}</td><td>${badge(row.status)}${!['committed', 'paid'].includes(row.status) ? '<span class="subtext">Historical commitment</span>' : ''}</td><td class="money">${money(row.committed_cents)}</td><td class="money">${money(row.received_cents ?? 0)}</td><td class="money">${row.committed_cents == null ? 'Not set' : money(Math.max(0, row.committed_cents - (row.received_cents || 0)))}</td><td>${row.contribution_type === 'cash' ? '<span class="subtext">Cash only</span>' : `<span class="status-badge ${row.fulfilled_at ? 'status-paid' : 'status-followup'}">${row.fulfilled_at ? 'Fulfilled' : 'Awaiting fulfillment'}</span><span class="subtext">${escapeHtml(row.in_kind_description || '')}</span>`}</td><td>${row.logo_url ? `<img class="logo-thumb" src="${escapeHtml(row.logo_url)}" alt="${escapeHtml(row.business_name)} logo">` : '<span class="subtext">Needed</span>'}</td><td><button class="button secondary small" data-open-motion="${escapeHtml(row.id)}" data-payment-focus>Manage</button></td></tr>`).join('')}</tbody></table></div>`;
}

function digestCards(items) {
  return items.map(row => `<details class="digest"><summary><strong>${escapeHtml(row.subject || 'Overdue sponsorship follow-ups')}</strong><span class="digest-meta">To: ${escapeHtml(row.recipient)} · ${escapeHtml(dateLabel(row.local_date))} · Preview only</span></summary><div class="digest-body">${escapeHtml(row.body_text || '')}</div><div class="digest-links">${(row.motion_ids || []).map(id => `<a class="button secondary small" href="/admin-sponsorships?motion=${encodeURIComponent(id)}">Open ${escapeHtml(state.motions.find(motion => motion.id === id)?.business_name || 'prospect')}</a>`).join('')}</div></details>`).join('');
}

function renderInbox() {
  return `<div class="inbox-list">${state.livePreviews !== null ? `<h3 class="inbox-heading">Current eligibility · refreshed now</h3>${state.livePreviews.length ? digestCards(state.livePreviews) : '<p class="hint">No owners currently have eligible overdue follow-ups.</p>'}` : ''}<h3 class="inbox-heading">Captured daily previews</h3>${state.reminders.length ? digestCards(state.reminders) : empty('No reminders captured yet', 'Capture today’s previews to review each owner’s overdue summary. No email will be sent.')}</div>`;
}

function render() {
  renderSummary();
  const config = {
    outreach: ['The weekly review', 'Keep the next conversation moving.', '+ Add prospect'],
    contacts: ['A contact bank that grows with you', 'Business details are shared across every year and campaign.', '+ Add contact'],
    sponsorships: ['From commitment to contribution', 'Track payments, in-kind fulfillment, and the assets you need.', '+ Add prospect'],
    inbox: ['The right nudge, only when it’s due', 'One overdue summary per owner, per Pacific calendar day.', '+ Add prospect'],
  }[state.tab];
  $('#view-title').textContent = config[0];
  $('#view-description').textContent = config[1];
  $('#add-primary').textContent = config[2];
  $('.tabs').querySelectorAll('button').forEach(button => { const active = button.dataset.tab === state.tab; button.classList.toggle('active', active); if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
  const inbox = state.tab === 'inbox';
  $('#filters').hidden = inbox;
  $('#inbox-controls').hidden = !inbox;
  for (const name of ['campaign', 'status', 'owner', 'overdue']) $(`#${name}-filter-label`).hidden = state.tab === 'contacts';
  $('#search').placeholder = state.tab === 'contacts' ? 'Search businesses or primary contacts…' : 'Business, contact, or next action…';
  let rows = filterMotions(state.motions, currentFilters());
  if (state.tab === 'contacts') {
    const needle = $('#search').value.toLowerCase().trim();
    rows = state.contacts.filter(row => !needle || [row.business_name, row.contact_name, row.email, row.website].some(value => String(value || '').toLowerCase().includes(needle)));
    $('#results').innerHTML = contactTable(rows);
  } else if (state.tab === 'sponsorships') {
    rows = rows.filter(row => row.sponsorship_id);
    $('#results').innerHTML = sponsorshipTable(rows);
  } else if (inbox) {
    rows = state.reminders;
    $('#results').innerHTML = renderInbox();
  } else $('#results').innerHTML = outreachTable(rows);
  $('#result-count').textContent = `${rows.length} ${inbox ? 'captured preview' : state.tab === 'contacts' ? 'contact' : state.tab === 'sponsorships' ? 'sponsorship' : 'prospect'}${rows.length === 1 ? '' : 's'}`;
  $('#result-note').textContent = inbox ? 'Only overdue follow-ups. No email is sent.' : state.tab === 'contacts' ? 'Reusable across campaigns.' : 'Follow-up dates use Pacific time.';
}

function openEditor(title, body, eyebrow = 'SPONSORSHIP WORKSPACE') {
  $('#editor-title').textContent = title;
  $('#editor-eyebrow').textContent = eyebrow;
  $('#editor-content').innerHTML = body;
  notice('', false, true);
  if (!$('#editor').open) $('#editor').showModal();
  $('#editor').scrollTop = 0;
}

function ownerOptions(selected) {
  let options = state.owners.map(owner => option(owner.id, owner.name || owner.display_name || owner.email, selected)).join('');
  if (selected && !state.owners.some(owner => owner.id === selected)) options = option(selected, 'Former admin · Choose a new owner', selected) + options;
  return options;
}

function campaignOptions(selected, includeArchived = false) {
  return state.campaigns.filter(row => includeArchived || !row.archived_at).map(row => option(row.id, `${row.name}${row.archived_at ? ' · Archived' : ''}`, selected)).join('');
}

function motionForm(row = {}) {
  const exists = Boolean(row.id);
  return `<form id="motion-form"><div class="form-grid">${!exists ? select('contact_id', 'Business contact', option('', 'Choose an existing contact…', '') + state.contacts.map(contact => option(contact.id, contact.business_name, row.contact_id)).join(''), true) : ''}
    ${!exists ? select('campaign_id', 'Campaign', campaignOptions(row.campaign_id)) : ''}
    ${select('owner_user_id', 'HTV owner', ownerOptions(row.owner_user_id || state.user.id))}
    ${select('status', 'Outreach status', Object.entries(STATUSES).map(([value, label]) => option(value, label, row.status || 'not_contacted')).join(''))}
    ${textarea('notes', 'Current notes', row.notes, 'placeholder="What should the team know?"')}
    ${field('next_action', 'Next action', row.next_action, { full: true, extra: 'placeholder="e.g. Send the sponsorship proposal"' })}
    ${field('follow_up_on', 'Follow-up date · Pacific', row.follow_up_on, { type: 'date' })}
    ${exists && row.follow_up_completed_at ? '<p class="hint">✓ This follow-up is complete. A changed next action or date starts a new unfinished follow-up.</p>' : '<p class="hint">Only unfinished follow-ups before today are overdue.</p>'}
  </div><div class="form-actions"><button class="button primary" type="submit">${exists ? 'Save outreach' : 'Add prospect'}</button>${exists && !row.follow_up_completed_at && row.follow_up_on ? '<button class="button secondary" type="button" id="complete-followup">✓ Complete follow-up</button>' : ''}${!exists ? '<button class="button quiet" type="button" id="create-contact-first">+ Create a new contact first</button>' : ''}</div></form>`;
}

function newMotion(contactId = '') {
  if (!state.campaigns.some(row => !row.archived_at)) { manageCampaigns(); notice('Create an active campaign before adding prospects.', false, true); return; }
  const selected = $('#campaign-filter').value;
  const campaignId = state.campaigns.find(row => row.id === selected && !row.archived_at)?.id || state.campaigns.find(row => !row.archived_at)?.id;
  openEditor('Add a prospect', '<p class="drawer-callout">Choose a contact from the reusable bank. Outreach, ownership, and history stay specific to this campaign.</p>' + motionForm({ contact_id: contactId, campaign_id: campaignId }), 'START A CONVERSATION');
  bindMotionForm(null);
  $('#create-contact-first').addEventListener('click', () => editContact(null, { useAfterSave: true }));
}

function bindMotionForm(row) {
  const form = $('#motion-form');
  if (row) configureConflict(form, `/motions/${row.id}`, row);
  form.elements.status.addEventListener('change', () => {
    if (form.elements.status.value !== 'paid' || row?.status === 'paid') return;
    if (row && state.detail?.commitment) {
      $('#commitment-section')?.scrollIntoView({ behavior: 'smooth' });
      $('#commitment-form [name="received_amount"]')?.focus({ preventScroll: true });
      notice('Enter the cash totals and save the sponsorship below. Paid is set when the positive committed amount is fully received.', false, true);
    } else notice('Save this prospect as Committed first, then record the cash amounts to mark it Paid.', false, true);
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    saving(form, async session => {
      const data = Object.fromEntries(new FormData(form));
      if (!row && !data.contact_id) throw new Error('Choose a business contact first.');
      if (!data.owner_user_id) throw new Error('An active admin owner is required.');
      data.follow_up_on ||= null;
      if (row) {
        data.revision = row.revision;
        if (data.next_action !== (row.next_action || '') || data.follow_up_on !== (row.follow_up_on || null)) data.follow_up_completed_at = null;
      }
      if (data.status === 'paid' && row?.status !== 'paid') {
        if (row && state.detail?.commitment) { $('#commitment-section')?.scrollIntoView({ behavior: 'smooth' }); throw new Error('Enter the cash amounts below and save the sponsorship. Paid is set when the positive committed amount is fully received.'); }
        throw new Error('Start with Committed, then enter the committed and received cash amounts to mark it Paid.');
      }
      const result = await request(row ? `/motions/${row.id}` : '/motions', { method: row ? 'PATCH' : 'POST', body: data, session });
      await loadData();
      await openMotion(result.item.id, false, true);
      notice('Outreach saved.', false, true);
    });
  });
  let completedAt;
  $('#complete-followup')?.addEventListener('click', () => saving(form, async session => {
    completedAt ||= new Date().toISOString();
    await request(`/motions/${row.id}`, { method: 'PATCH', body: { revision: row.revision, follow_up_completed_at: completedAt }, session });
    await loadData(); await openMotion(row.id, false, true);
    notice('Follow-up completed. It is no longer eligible for overdue reminders.', false, true);
  }));
}

async function openMotion(id, focusPayment = false, preserveDraftOnError = false) {
  if (!preserveDraftOnError) openEditor('Loading prospect…', '<p class="loading-text">Loading the latest saved details…</p>');
  try {
    const result = await request(`/motions/${encodeURIComponent(id)}`);
    const row = result.item;
    if (result.commitment) result.commitment.logo_url ||= row.logo_url;
    state.detail = result;
    const contact = state.contacts.find(item => item.id === row.contact_id);
    const activities = result.activities || [];
    const email = contact?.email ?? row.email;
    const body = `<section class="inline-contact" aria-label="Primary contact details"><div class="contact-card-heading"><div><span class="contact-caption">Primary contact</span><p><strong>${escapeHtml(contact?.contact_name || row.contact_name || 'Not provided')}</strong></p></div><button class="button secondary small" id="edit-motion-contact">Edit contact</button></div><dl class="contact-details"><dt>Phone</dt><dd>${phoneLink(contact?.phone)}</dd><dt>Email</dt><dd>${email ? `<a class="contact-link" href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a>` : 'Not provided'}</dd><dt>Campaign</dt><dd>${escapeHtml(row.campaign_name)}</dd></dl></section>
      ${row.owner_active === false || row.owner_active === 0 ? '<p class="drawer-callout warning">This owner no longer has admin access. Reassign this prospect to an active admin. No overdue reminder will be generated for the former owner.</p>' : ''}
      ${row.campaign_archived_at ? '<p class="drawer-callout">This campaign is archived. Its history is preserved and overdue reminders are paused.</p>' : ''}
      ${motionForm(row)}
      ${result.commitment ? commitmentForm(result.commitment) : '<section class="form-section"><h3>Sponsorship details</h3><p class="intro">Set the outreach status to Committed to track cash, in-kind support, payment references, and a logo.</p></section>'}
      <section class="form-section"><h3>What’s been done</h3><p class="intro">Log completed conversations and actions so the team stays aligned.</p><form id="activity-form"><div class="form-grid">${select('type', 'Activity type', [['note', 'Note'], ['email', 'Email'], ['call', 'Call'], ['meeting', 'Meeting']].map(([value, label]) => option(value, label, 'note')).join(''))}${textarea('description', 'Completed activity', '', 'required placeholder="e.g. Spoke with Morgan; proposal review is next Tuesday."')}</div><div class="form-actions"><button class="button secondary" type="submit">Log activity</button></div></form><ol class="activity-list">${activities.map(activity => `<li>${escapeHtml(activity.description)}<time datetime="${escapeHtml(activity.created_at)}">${escapeHtml(activity.actor_name || activity.type || 'Team update')} · ${escapeHtml(timeLabel(activity.created_at))} PT</time></li>`).join('') || '<li>No activity logged yet.</li>'}</ol></section>`;
    openEditor(row.business_name, body, `${row.campaign_name || 'OUTREACH'} · ${STATUSES[row.status]}`);
    bindMotionForm(row);
    $('#edit-motion-contact').addEventListener('click', () => editContact(contact, { returnMotionId: id }));
    $('#activity-form').addEventListener('submit', event => {
      event.preventDefault();
      const form = event.currentTarget;
      saving(form, async session => {
        await request(`/motions/${id}/activities`, { method: 'POST', body: Object.fromEntries(new FormData(form)), session });
        await loadData(); await openMotion(id, false, true); notice('Activity added to the shared history.', false, true);
      });
    });
    if (result.commitment) bindCommitment(row, result.commitment);
    if (focusPayment) $('#commitment-section')?.scrollIntoView();
  } catch (error) {
    if (preserveDraftOnError) throw error;
    notice(error.message, true, true);
  }
}

function commitmentForm(record) {
  return `<section class="form-section" id="commitment-section"><h3>The actual sponsorship</h3><p class="intro">Cash amounts are totals, in USD. Positive cash commitments become Paid when fully received. In-kind support has its own fulfillment status.</p><form id="commitment-form"><div class="form-grid">
    ${select('contribution_type', 'Contribution type', [['cash', 'Cash'], ['in_kind', 'In-kind'], ['both', 'Cash + in-kind']].map(([value, label]) => option(value, label, record.contribution_type)).join(''), true)}
    ${field('committed_amount', 'Cash committed · USD', moneyInput(record.committed_cents), { extra: 'inputmode="decimal" placeholder="Amount not yet known"' })}
    ${field('received_amount', 'Cash received to date · USD', moneyInput(record.received_cents ?? 0), { extra: 'inputmode="decimal" placeholder="0.00"' })}
    ${textarea('in_kind_description', 'Donated goods / services', record.in_kind_description)}
    <label class="checkbox-field full"><input name="fulfilled" type="checkbox"${record.fulfilled_at ? ' checked' : ''}><span>In-kind contribution received / fulfilled</span></label>
    ${select('payment_method', 'Payment method', option('', 'Not set', record.payment_method) + [['check', 'Check'], ['bank_transfer', 'Bank transfer'], ['cash', 'Cash'], ['other', 'Other']].map(([value, label]) => option(value, label, record.payment_method)).join(''))}
    ${field('check_reference', 'Check reference', record.check_reference)}
    ${field('invoice_number', 'Invoice number', record.invoice_number)}
    ${select('invoice_status', 'Invoice status', [['not_issued', 'Not issued'], ['issued', 'Issued'], ['paid', 'Paid']].map(([value, label]) => option(value, label, record.invoice_status)).join(''))}
  </div><p class="hint">Invoice and check references only. Paid invoices require a settled cash commitment.</p><div class="form-actions"><button class="button primary" type="submit">Save sponsorship</button></div></form>
  <form id="logo-form" class="form-section"><h3>Sponsor logo</h3>${record.logo_url ? `<img class="logo-preview" src="${escapeHtml(record.logo_url)}" alt="Current sponsor logo">` : '<p class="intro">No logo uploaded yet.</p>'}<label><span>PNG, JPEG, or WebP · Maximum 5 MB</span><input name="logo" type="file" accept="image/png,image/jpeg,image/webp" required></label><div class="form-actions"><button type="submit" class="button secondary">${record.logo_url ? 'Replace logo' : 'Upload logo'}</button></div></form></section>`;
}

function bindCommitment(motion, record) {
  let fulfilledAt;
  const logoRecord = { ...record };
  configureConflict($('#commitment-form'), `/motions/${motion.id}/commitment`, record, row => ({
    ...row, committed_amount: moneyInput(row.committed_cents), received_amount: moneyInput(row.received_cents ?? 0), fulfilled: row.fulfilled_at ? 'Yes' : 'No',
  }));
  configureConflict($('#logo-form'), `/motions/${motion.id}/commitment`, logoRecord, row => ({ logo: row.logo_original_filename || 'No logo uploaded' }));
  $('#commitment-form').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    saving(form, async session => {
      const values = Object.fromEntries(new FormData(form));
      if (values.fulfilled) fulfilledAt ||= record.fulfilled_at || new Date().toISOString();
      const payload = { revision: record.revision, contribution_type: values.contribution_type, committed_cents: parseMoney(values.committed_amount), received_cents: parseMoney(values.received_amount) ?? 0, in_kind_description: values.in_kind_description, fulfilled_at: values.fulfilled ? fulfilledAt : null, payment_method: values.payment_method || null, check_reference: values.check_reference, invoice_number: values.invoice_number, invoice_status: values.invoice_status };
      await request(`/motions/${motion.id}/commitment`, { method: 'PATCH', body: payload, session });
      await loadData(); await openMotion(motion.id, true, true); notice('Sponsorship saved. Payment status has been recalculated.', false, true);
    });
  });
  $('#logo-form').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    saving(form, async session => {
      const file = form.elements.logo.files[0];
      if (!file) throw new Error('Choose a logo file first.');
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG, or WebP image.');
      if (!file.size || file.size > 5 * 1024 * 1024) throw new Error('The logo must be larger than zero bytes and no more than 5 MB.');
      const bytes = await file.arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      await request(`/motions/${motion.id}/logo`, { method: 'POST', upload: bytes, headers: { 'Content-Type': file.type, 'X-Filename': encodeURIComponent(file.name), 'X-Revision': String(logoRecord.revision) }, fingerprint: JSON.stringify([logoRecord.revision, file.name, file.type, hash]), session });
      await loadData(); await openMotion(motion.id, true, true); notice('Logo uploaded and saved privately for admins.', false, true);
    });
  });
}

function editContact(record, { useAfterSave = false, returnMotionId = null } = {}) {
  const row = record || {};
  const history = state.motions.filter(motion => motion.contact_id === row.id);
  openEditor(row.id ? `Edit ${row.business_name}` : 'Add a business contact', `<p class="drawer-callout">One business, one primary contact. Edits here update the shared contact in every campaign.</p><form id="contact-form"><div class="form-grid">
    ${field('business_name', 'Business name', row.business_name, { full: true, required: true, extra: 'maxlength="200"' })}
    ${field('contact_name', 'Primary contact name', row.contact_name)}${field('email', 'Email', row.email, { type: 'email' })}
    ${field('phone', 'Phone', row.phone, { type: 'tel' })}${field('website', 'Website', row.website, { type: 'url', extra: 'placeholder="https://example.com"' })}
    ${textarea('notes', 'General contact notes', row.notes)}
  </div><p id="contact-warning" class="contact-warning" hidden></p><div class="form-actions"><button class="button primary" type="submit">${row.id ? 'Save contact' : 'Add contact'}</button>${returnMotionId ? `<button class="button secondary" type="button" data-open-motion="${escapeHtml(returnMotionId)}">Back to outreach</button>` : ''}</div></form>
  ${row.id ? `<section class="form-section"><h3>Campaign history</h3><p class="intro">Each campaign has its own owner, outreach history, and sponsorship.</p><div class="contact-history">${history.map(motion => `<button class="button secondary" data-open-motion="${escapeHtml(motion.id)}">${escapeHtml(motion.campaign_name)} · ${escapeHtml(STATUSES[motion.status])}</button>`).join('') || '<p class="hint">Not in a campaign yet.</p>'}</div><div class="form-actions"><button class="button secondary" data-use-contact="${escapeHtml(row.id)}">+ Add to another campaign</button></div></section>` : ''}`, 'REUSABLE CONTACTS BANK');
  const form = $('#contact-form');
  if (row.id) configureConflict(form, `/contacts/${row.id}`, row);
  form.addEventListener('input', () => {
    const name = form.elements.business_name.value.trim().toLowerCase();
    const website = form.elements.website.value.trim().replace(/\/$/, '').toLowerCase();
    const matches = state.contacts.filter(contact => contact.id !== row.id && ((name && contact.business_name.toLowerCase() === name) || (website && String(contact.website || '').replace(/\/$/, '').toLowerCase() === website)));
    $('#contact-warning').hidden = !matches.length;
    $('#contact-warning').textContent = matches.length ? `Possible existing contact: ${matches.map(contact => contact.business_name).join(', ')}. Check the contacts bank before adding a duplicate.` : '';
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    saving(form, async session => {
      const payload = Object.fromEntries(new FormData(form));
      if (row.id) payload.revision = row.revision;
      const result = await request(row.id ? `/contacts/${row.id}` : '/contacts', { method: row.id ? 'PATCH' : 'POST', body: payload, session });
      await loadData();
      if (useAfterSave) { newMotion(result.item.id); notice('Contact created. Choose its campaign and outreach details.', false, true); }
      else if (returnMotionId) { await openMotion(returnMotionId, false, true); notice('Shared contact updated across campaigns.', false, true); }
      else { editContact(result.item); notice('Contact saved.', false, true); }
    });
  });
}

function manageCampaigns(record = null) {
  const row = record || {};
  let archivedAt;
  openEditor(row.id ? `Edit ${row.name}` : 'Manage campaigns', `<p class="drawer-callout">Start a fresh sponsorship list for a new year or event. Contacts remain reusable; outreach and payments stay with their original campaign.</p><form id="campaign-form"><div class="form-grid">
    ${field('name', 'Campaign name', row.name, { required: true, extra: 'placeholder="e.g. HTV 2027"' })}
    ${field('year', 'Year', row.year || new Date().getFullYear() + 1, { type: 'number', required: true, extra: 'min="2000" max="2200"' })}
    ${textarea('purpose', 'Purpose', row.purpose)}
    ${select('event_instance_id', 'Linked event · optional', option('', 'No event link', row.event_instance_id) + state.events.map(event => option(event.id, `${event.title || event.event_slug || 'Event'}${event.starts_at ? ` · ${dateLabel(event.starts_at)}` : ''}`, row.event_instance_id)).join(''), true)}
    ${row.id ? `<label class="checkbox-field full"><input name="archived" type="checkbox"${row.archived_at ? ' checked' : ''}><span>Archive this campaign (keep its history; pause reminders)</span></label>` : ''}
  </div><div class="form-actions"><button class="button primary" type="submit">${row.id ? 'Save campaign' : '+ Create campaign'}</button>${row.id ? '<button class="button secondary" id="new-campaign" type="button">New campaign</button>' : ''}</div></form>
  <div class="campaign-list">${state.campaigns.map(campaign => `<article><div><h3>${escapeHtml(campaign.name)}</h3><p>${escapeHtml(campaign.year)} · ${campaign.archived_at ? 'Archived' : 'Active'} · ${state.motions.filter(motion => motion.campaign_id === campaign.id).length} prospects</p></div><button class="button secondary small" data-edit-campaign="${escapeHtml(campaign.id)}">Edit</button></article>`).join('')}</div>`, 'ANNUAL & EVENT CAMPAIGNS');
  $('#new-campaign')?.addEventListener('click', () => manageCampaigns());
  if (row.id) configureConflict($('#campaign-form'), `/campaigns/${row.id}`, row, latest => ({ ...latest, archived: latest.archived_at ? 'Yes' : 'No' }));
  $('#campaign-form').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    saving(form, async session => {
      const data = Object.fromEntries(new FormData(form));
      const payload = { name: data.name, year: Number(data.year), purpose: data.purpose, event_instance_id: data.event_instance_id || null };
      if (data.archived) archivedAt ||= row.archived_at || new Date().toISOString();
      if (row.id) Object.assign(payload, { revision: row.revision, archived_at: data.archived ? archivedAt : null });
      const result = await request(row.id ? `/campaigns/${row.id}` : '/campaigns', { method: row.id ? 'PATCH' : 'POST', body: payload, session });
      await loadData(); manageCampaigns(result.item); notice('Campaign saved.', false, true);
    });
  });
}

async function loadInbox() { state.reminders = (await request('/reminders')).items || []; }

async function switchWorkspaceAccount(button) {
  button.disabled = true;
  button.textContent = 'Signing out…';
  try { await switchAdminAccount('/admin-sponsorships'); }
  catch (error) {
    button.disabled = false;
    button.textContent = 'Could not sign out. Try again';
    button.title = error.message;
  }
}

function bindPage() {
  $('#close-editor').addEventListener('click', () => $('#editor').close());
  $('#campaign-manage').addEventListener('click', () => manageCampaigns());
  $('#add-primary').addEventListener('click', () => state.tab === 'contacts' ? editContact() : newMotion());
  $('#refresh').addEventListener('click', async () => {
    try { await loadData(); if (state.tab === 'inbox') { await loadInbox(); render(); } notice('Workspace refreshed.'); }
    catch (error) { notice(error.message, true); }
  });
  for (const name of ['campaign-filter', 'owner-filter', 'status-filter', 'overdue-filter', 'search']) $(`#${name}`).addEventListener(name === 'search' ? 'input' : 'change', render);
  $('.tabs').addEventListener('click', async event => {
    const tab = event.target.closest('[data-tab]');
    if (!tab) return;
    state.tab = tab.dataset.tab;
    notice('');
    render();
    if (state.tab === 'inbox') try { await loadInbox(); render(); } catch (error) { notice(error.message, true); }
  });
  document.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.hasAttribute('data-switch-account')) void switchWorkspaceAccount(target);
    else if (target.dataset.openMotion) void openMotion(target.dataset.openMotion, target.hasAttribute('data-payment-focus'));
    else if (target.dataset.editContact) editContact(state.contacts.find(row => row.id === target.dataset.editContact));
    else if (target.dataset.useContact) newMotion(target.dataset.useContact);
    else if (target.dataset.editCampaign) manageCampaigns(state.campaigns.find(row => row.id === target.dataset.editCampaign));
    else if (target.hasAttribute('data-add-motion')) newMotion();
    else if (target.hasAttribute('data-add-contact')) editContact();
  });
  $('#generate-previews').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const result = await request('/reminders/preview', { method: 'POST', body: {} });
      await loadInbox(); state.livePreviews = (await request('/reminders/preview')).items || []; render();
      notice(result.created_count ? `${result.created_count} owner preview${result.created_count === 1 ? '' : 's'} captured. No email was sent.` : 'No new previews needed. Owners without overdue work are skipped, and today’s captured summaries are not duplicated.');
    } catch (error) { notice(error.message, true); }
    finally { button.disabled = false; }
  });
  $('#refresh-previews').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try { state.livePreviews = (await request('/reminders/preview')).items || []; render(); notice('Current eligibility refreshed. Captured daily previews remain unchanged.'); }
    catch (error) { notice(error.message, true); }
    finally { button.disabled = false; }
  });
}

async function initialize() {
  bindPage();
  try {
    const session = await request('');
    state.user = session.user;
    state.previewMode = Boolean(session.preview_mode);
    $('#session-name').textContent = `Signed in as ${state.user.name || state.user.email}`;
    $('#preview-label').hidden = !state.previewMode;
    await loadData();
    const active = state.campaigns.find(row => !row.archived_at);
    if (active) { state.selectedCampaign = active.id; $('#campaign-filter').value = active.id; render(); }
    $('#loading').hidden = true;
    $('#app').hidden = false;
    const motion = new URLSearchParams(window.location.search).get('motion');
    if (motion) await openMotion(motion);
  } catch (error) {
    $('#loading').innerHTML = empty('Workspace unavailable', escapeHtml(error.message), '<button type="button" class="button secondary" data-switch-account>Sign in with another account</button> <button class="button secondary" id="retry-load">Try again</button>');
    $('#retry-load').addEventListener('click', () => window.location.reload());
  }
}

if (typeof document !== 'undefined' && document.querySelector('#workspace')) void initialize();
