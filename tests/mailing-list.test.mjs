import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { onRequestOptions, onRequestPost } from '../functions/api/subscribe.js';
import {
  buildResendContactPayload,
  validateSubscribePayload,
} from '../functions/_shared/mailing-list.js';
import worker from '../worker.js';

function jsonRequest(body) {
  return new Request('https://hackthevalley.org/api/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function mockFetch(responses, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift() || { status: 200, body: { id: 'contact_default' } };
    return new Response(JSON.stringify(next.body || {}), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

test('validateSubscribePayload accepts a simple community signup and normalizes fields', () => {
  const result = validateSubscribePayload({
    email: '  BUILDER@Example.COM ',
    name: '  Ada Lovelace  ',
    interest: 'Organizing future events',
    source: 'homepage',
  });

  assert.equal(result.ok, true);
  assert.equal(result.subscriber.email, 'builder@example.com');
  assert.equal(result.subscriber.name, 'Ada Lovelace');
  assert.equal(result.subscriber.interest, 'Organizing future events');
  assert.equal(result.subscriber.source, 'homepage');
});

test('validateSubscribePayload rejects invalid email, honeypot spam, and non-object payloads', () => {
  assert.equal(validateSubscribePayload({ email: 'bad' }).ok, false);
  const spam = validateSubscribePayload({ email: 'builder@example.com', website: 'https://spam.example' });
  assert.equal(spam.ok, false);
  assert.match(spam.errors.join('\n'), /Spam check failed/);
  assert.equal(validateSubscribePayload(null).ok, false);
});

test('buildResendContactPayload sends only Resend-supported contact fields', () => {
  const payload = buildResendContactPayload(
    {
      email: 'builder@example.com',
      name: 'Ada Lovelace',
      interest: 'Mentor nights',
      source: 'homepage',
    },
    { RESEND_ALL_CONTACTS_SEGMENT_ID: 'seg_general' }
  );

  assert.equal(payload.email, 'builder@example.com');
  assert.equal(payload.first_name, 'Ada');
  assert.equal(payload.last_name, 'Lovelace');
  assert.equal(payload.unsubscribed, false);
  assert.equal(payload.properties, undefined);
  assert.equal(payload.segments, undefined);
  assert.doesNotMatch(JSON.stringify(payload), /RESEND_API_KEY|re_[A-Za-z0-9]/);
});

test('buildResendContactPayload preserves unsubscribe status when updating existing contacts', () => {
  const payload = buildResendContactPayload(
    { email: 'builder@example.com', name: 'Ada Lovelace', interest: '', source: 'homepage' },
    {},
    { includeSubscriptionStatus: false }
  );
  assert.equal(Object.hasOwn(payload, 'unsubscribed'), false);
});

test('subscribe API creates a Resend contact with the configured API key', async () => {
  const calls = [];
  const response = await onRequestPost({
    request: jsonRequest({ email: 'builder@example.com', name: 'Ada Lovelace', source: 'homepage' }),
    env: { RESEND_API_KEY: 're_test_key', RESEND_ALL_CONTACTS_SEGMENT_ID: 'seg_general' },
    fetch: mockFetch([{ status: 200, body: { id: 'contact_123' } }], calls),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    message: 'You are on the Hack the Valley updates list.',
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.resend.com/contacts');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer re_test_key');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.email, 'builder@example.com');
  assert.equal(body.properties, undefined);
  assert.equal(calls[1].url, 'https://api.resend.com/contacts/builder%40example.com/segments/seg_general');
  assert.equal(calls[1].init.method, 'POST');
});

test('subscribe API patches an existing Resend contact when create returns a duplicate conflict', async () => {
  const calls = [];
  const response = await onRequestPost({
    request: jsonRequest({ email: 'Builder@Example.com', name: 'Ada Lovelace' }),
    env: { RESEND_API_KEY: 're_test_key', RESEND_ALL_CONTACTS_SEGMENT_ID: 'seg_general' },
    fetch: mockFetch([
      { status: 409, body: { message: 'Contact already exists' } },
      { status: 200, body: { id: 'contact_123' } },
    ], calls),
  });

  assert.equal(response.status, 200);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].url, 'https://api.resend.com/contacts/builder%40example.com');
  assert.equal(calls[1].init.method, 'PATCH');
  const updateBody = JSON.parse(calls[1].init.body);
  assert.equal(Object.hasOwn(updateBody, 'unsubscribed'), false);
  assert.equal(calls[2].url, 'https://api.resend.com/contacts/builder%40example.com/segments/seg_general');
});

test('subscribe refuses to claim success without the configured General segment', async () => {
  const calls = [];
  const response = await onRequestPost({
    request: jsonRequest({ email: 'builder@example.com' }),
    env: { RESEND_API_KEY: 're_test_key' },
    fetch: mockFetch([], calls),
  });
  assert.equal(response.status, 503);
  assert.equal(calls.length, 0);
});

test('subscribe reports a failed segment add rather than claiming list membership', async () => {
  const response = await onRequestPost({
    request: jsonRequest({ email: 'builder@example.com' }),
    env: { RESEND_API_KEY: 're_test_key', RESEND_ALL_CONTACTS_SEGMENT_ID: 'seg_general' },
    fetch: mockFetch([{ status: 200 }, { status: 503 }]),
  });
  assert.equal(response.status, 502);
});

test('subscribe API does not pretend success when Resend is not configured', async () => {
  const response = await onRequestPost({
    request: jsonRequest({ email: 'builder@example.com' }),
    env: {},
    fetch: mockFetch([]),
  });

  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /not configured/);
});

test('subscribe API supports OPTIONS preflight', () => {
  const response = onRequestOptions();
  assert.equal(response.status, 204);
  assert.match(response.headers.get('access-control-allow-methods'), /POST/);
});

test('worker routes deployed API requests instead of serving static 404s', async () => {
  const options = await worker.fetch(
    new Request('https://hackthevalley.org/api/subscribe', { method: 'OPTIONS' }),
    { ASSETS: { fetch: () => new Response('static miss', { status: 404 }) } },
    {}
  );

  assert.equal(options.status, 204);

  const badPost = await worker.fetch(
    jsonRequest({ email: 'bad' }),
    { ASSETS: { fetch: () => new Response('static miss', { status: 404 }) } },
    {}
  );

  assert.equal(badPost.status, 400);
  assert.match((await badPost.json()).error, /Could not join/);
});

test('worker falls through non-API requests to static assets', async () => {
  const response = await worker.fetch(
    new Request('https://hackthevalley.org/'),
    { ASSETS: { fetch: () => new Response('home', { status: 200 }) } },
    {}
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'home');
});

test('homepage exposes real mailing-list form instead of temporary mailto CTA', () => {
  const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const eventsHtml = readFileSync(new URL('../public/events/index.html', import.meta.url), 'utf8');

  assert.match(indexHtml, /id="updates"/);
  assert.match(indexHtml, /action="\/api\/subscribe"/);
  assert.match(indexHtml, /name="email"/);
  assert.match(indexHtml, /mailing-list\.js/);
  assert.doesNotMatch(indexHtml, /Temporary update CTA/);
  assert.doesNotMatch(eventsHtml, /Temporary update CTA/);
});

test('top navigation stays participant-focused and keeps the survey off the homepage', () => {
  const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const eventHtml = readFileSync(new URL('../public/events/hack-the-valley-2026/index.html', import.meta.url), 'utf8');

  assert.doesNotMatch(indexHtml, /Take the survey/);
  assert.doesNotMatch(indexHtml, /forms\.gle\/CpechvKU24cPVAj38/);
  assert.doesNotMatch(indexHtml, />2026 Recap</);
  assert.match(indexHtml, /data-participant-nav/);
  assert.match(indexHtml, />Events<\/a>/);
  assert.match(indexHtml, />Projects<\/a>/);
  assert.match(indexHtml, />Blog<\/a>/);
  assert.match(indexHtml, />Profile<\/a>/);
  assert.match(indexHtml, />Leaderboard<\/a>/);

  assert.doesNotMatch(eventHtml, /Help Build/);
  assert.doesNotMatch(eventHtml, /Help build the next one/);
  assert.match(eventHtml, /data-nav-link="events" href="\/events"[^>]*aria-current="page"[^>]*>Events<\/a>/);
  assert.match(eventHtml, /data-nav-link="projects" href="\/projects\/"[^>]*>Projects<\/a>/);
  assert.match(eventHtml, /data-nav-link="blog" href="\/blog\/"[^>]*>Blog<\/a>/);
  assert.match(eventHtml, /data-nav-link="profile" href="\/me\/"[^>]*>Profile<\/a>/);
  assert.match(eventHtml, /data-nav-link="leaderboard" href="\/leaderboard\/"[^>]*>Leaderboard<\/a>/);
});

test('event page relies on the embedded flyer instead of extra numbered stat cards', () => {
  const eventHtml = readFileSync(new URL('../public/events/hack-the-valley-2026/index.html', import.meta.url), 'utf8');

  assert.match(eventHtml, /Hack the Valley 2026<\/h1>/);
  assert.doesNotMatch(eventHtml, /Hack the Valley 2026\s*<span[^>]*>recap\.<\/span>/);
  assert.doesNotMatch(eventHtml, /day build sprint/);
  assert.doesNotMatch(eventHtml, /public-safe projects curated/);
  assert.doesNotMatch(eventHtml, /photo highlights selected/);
  assert.doesNotMatch(eventHtml, /tracks: education, social impact, AI/);
  assert.match(eventHtml, /hack-the-valley-by-the-numbers\.png/);
});
