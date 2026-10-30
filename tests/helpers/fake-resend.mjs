// A stateful stand-in for the parts of Resend's API that admin email uses: one
// segment and its contacts, broadcasts (a broadcast created with `send: true`
// is "queued", as Resend is delivering it), and single emails, kept in
// `resend.emails`. Like Resend, it refuses a broadcast name over 70
// characters. Pass `resend.fetch` as the fetcher; every request is recorded in
// `resend.calls`. Set `resend.nextCreate` to make the next POST /broadcasts
// misbehave:
//   'lose'    create the broadcast, then fail as if the response was lost
//   'down'    answer 503 without creating anything
//   'reject'  answer 422 without creating anything
export function createFakeResend({ segment = { id: 'seg_general', name: 'General' }, contacts = [] } = {}) {
  const resend = {
    broadcasts: [],
    emails: [],
    calls: [],
    nextCreate: null,
    async fetch(url, init = {}) {
      const { pathname } = new URL(url);
      const method = init.method || 'GET';
      resend.calls.push({ method, path: pathname, body: init.body ? JSON.parse(init.body) : undefined });
      if (method === 'GET' && pathname === `/segments/${segment.id}`) return Response.json({ object: 'segment', ...segment });
      if (method === 'GET' && pathname === `/segments/${segment.id}/contacts`) return Response.json({ object: 'list', has_more: false, data: contacts });
      if (method === 'GET' && pathname === '/broadcasts') return Response.json({ object: 'list', has_more: false, data: resend.broadcasts });
      if (method === 'POST' && pathname === '/broadcasts') {
        const mode = resend.nextCreate;
        resend.nextCreate = null;
        if (mode === 'reject') return Response.json({ name: 'validation_error', message: 'Invalid `from` field.' }, { status: 422 });
        if (mode === 'down') return Response.json({ name: 'internal_server_error', message: 'Unavailable' }, { status: 503 });
        const body = JSON.parse(init.body);
        if (String(body.name || '').length > 70) {
          return Response.json({ statusCode: 422, message: 'Field `name` has a maximum of 70 items.', name: 'validation_error' }, { status: 422 });
        }
        const broadcast = {
          id: `bc_${resend.broadcasts.length + 1}`,
          name: body.name,
          segment_id: body.segment_id,
          status: body.send ? 'queued' : 'draft',
          created_at: new Date().toISOString(),
        };
        resend.broadcasts.unshift(broadcast);
        if (mode === 'lose') throw new TypeError('Network connection lost.');
        return Response.json({ id: broadcast.id });
      }
      if (method === 'POST' && pathname === '/emails') {
        resend.emails.push(JSON.parse(init.body));
        return Response.json({ id: `em_${resend.emails.length}` });
      }
      return Response.json({ name: 'not_found', message: 'Not found' }, { status: 404 });
    },
  };
  return resend;
}
