# Resend `General` as the HTV updates audience

Resend Broadcasts require a segment ID; `General` is the one HTV-wide updates audience. Its name alone does not make it include every contact. The verified existing General ID is set as `RESEND_ALL_CONTACTS_SEGMENT_ID` in `wrangler.toml` (a non-secret Worker variable). Do not use an event/year segment or assume the deprecated `RESEND_SEGMENT_ID` config points to General. Verify the ID still resolves to General before each deployment.

Both `/api/subscribe` and opted-in event registrations now add newly created **and existing** Resend contacts to that ID. Event registrants who did not opt in are not added. Existing unsubscribed/suppressed contacts remain unsubscribed; adding segment membership never changes that status. A failed segment add is recorded as a failed sync, not a success. Website subscribe fails closed when the segment is unconfigured.

## One-time existing-contact reconciliation

After confirming the actual segment ID, assemble a **private JSON array** of email addresses whose HTV updates opt-in is verified (outside the repo). After approval to alter live segment membership, run with the existing Resend API key in a secure shell (never commit the key or email list):

```sh
RESEND_API_KEY=... RESEND_ALL_CONTACTS_SEGMENT_ID=... node scripts/sync-general-segment.mjs
# Inspect counts, then only after approval:
RESEND_API_KEY=... RESEND_ALL_CONTACTS_SEGMENT_ID=... node scripts/sync-general-segment.mjs --apply --consent-file=/secure/path/verified-opt-ins.json
```

Dry-run prints **counts only**. Apply checks that the ID still names `General`, adds only approved-list contacts missing from it without sending mail or changing unsubscribe status, then reads back their exact membership. It is safe to rerun after partial failures; do not infer consent solely from global contact existence. If the readback reports remaining global contacts, they stay outside General, and so outside admin email, until their eligibility is resolved.

## Release order

1. Read current Resend contact/General membership and confirm which global contacts are eligible for HTV updates. Review unmatched entries before any backfill.
2. Verify `wrangler.toml` sets the Worker `RESEND_ALL_CONTACTS_SEGMENT_ID` variable to General's actual ID **before** deploying this code, so website subscriptions do not fail closed.
3. Deploy only after the HTV merge/deploy approval. Verify a new opted-in signup reaches General without sending a broadcast. Do not create production junk contact data for smoke tests; use an existing approved test address if available.
4. Apply the approved one-time reconciliation and read back membership. Resend itself still filters unsubscribed/suppressed contacts on send.
5. Before any later send, verify the intended recipient set and require explicit human approval. Admin email (`/admin` → Email) is addressed to this ID only, with no placeholder or name-based fallback. The composer shows the segment's name and live contact count under "Goes to" (`GET /api/admin/message-drafts/audience`). "Send now" goes out only after the admin types SEND to approve that audience, and every send is audited (`message_draft.send`). A Resend draft can still be created instead, to review or schedule it in Resend.
