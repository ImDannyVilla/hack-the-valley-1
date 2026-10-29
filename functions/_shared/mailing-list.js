const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME_LENGTH = 120;
const MAX_INTEREST_LENGTH = 500;
const MAX_SOURCE_LENGTH = 80;

function cleanText(value, maxLength) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function splitName(name) {
  const parts = cleanText(name, MAX_NAME_LENGTH).split(' ').filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

export function validateSubscribePayload(payload = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    payload = {};
  }

  const errors = [];

  if (payload.website) {
    errors.push('Spam check failed.');
  }

  const email = String(payload.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    errors.push('Provide a valid email address.');
  }

  const subscriber = {
    email,
    name: cleanText(payload.name, MAX_NAME_LENGTH),
    interest: cleanText(payload.interest, MAX_INTEREST_LENGTH),
    source: cleanText(payload.source || 'website', MAX_SOURCE_LENGTH) || 'website',
  };

  return { ok: errors.length === 0, errors, subscriber };
}

export function buildResendContactPayload(subscriber, env = {}, options = {}) {
  const { firstName, lastName } = splitName(subscriber.name);
  const payload = {
    email: subscriber.email,
  };

  if (firstName) payload.first_name = firstName;
  if (lastName) payload.last_name = lastName;
  if (options.includeSubscriptionStatus !== false) {
    payload.unsubscribed = false;
  }

  return payload;
}

// Both website subscriptions and opted-in event signups use one broadcast audience.
// A synced contact outside it is not a completed updates-list subscription.
export function updatesSegmentId(env = {}) {
  const segmentId = String(env.RESEND_ALL_CONTACTS_SEGMENT_ID || '').trim();
  if (!segmentId) {
    const error = new Error('RESEND_ALL_CONTACTS_SEGMENT_ID is not configured.');
    error.status = 503;
    throw error;
  }
  return segmentId;
}

export async function addContactToUpdatesSegment({ email, env = {}, fetcher = fetch }) {
  const segmentId = updatesSegmentId(env);
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  const response = await fetcher(
    `https://api.resend.com/contacts/${encodeURIComponent(email)}/segments/${encodeURIComponent(segmentId)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
    }
  );

  if (!response.ok && response.status !== 409) {
    const error = new Error(`Resend segment add failed with HTTP ${response.status}: ${await readResponseText(response)}`);
    error.status = 502;
    throw error;
  }
}

async function readResponseText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

export async function syncContactWithResend({ subscriber, env = {}, fetcher = fetch }) {
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  if (!apiKey) {
    const error = new Error('Mailing list is not configured.');
    error.status = 503;
    throw error;
  }
  updatesSegmentId(env);

  const createBody = buildResendContactPayload(subscriber, env);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  const createResponse = await fetcher('https://api.resend.com/contacts', {
    method: 'POST',
    headers,
    body: JSON.stringify(createBody),
  });

  if (createResponse.ok) {
    await addContactToUpdatesSegment({ email: subscriber.email, env, fetcher });
    return { action: 'created' };
  }

  if (createResponse.status === 409) {
    const updateBody = buildResendContactPayload(subscriber, env, { includeSubscriptionStatus: false });
    const updateResponse = await fetcher(`https://api.resend.com/contacts/${encodeURIComponent(subscriber.email)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(updateBody),
    });
    if (updateResponse.ok) {
      await addContactToUpdatesSegment({ email: subscriber.email, env, fetcher });
      return { action: 'updated' };
    }
    const updateError = new Error(`Resend contact update failed with HTTP ${updateResponse.status}: ${await readResponseText(updateResponse)}`);
    updateError.status = 502;
    throw updateError;
  }

  const error = new Error(`Resend contact create failed with HTTP ${createResponse.status}: ${await readResponseText(createResponse)}`);
  error.status = 502;
  throw error;
}
