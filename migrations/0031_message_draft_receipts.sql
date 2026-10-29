-- Idempotency receipts for admin email drafts (POST /api/admin/message-drafts).
-- Guarantees at most one Resend draft per (admin, Idempotency-Key): a retry
-- after a timeout or a double click replays the recorded draft instead of
-- creating a second one. Same pattern as sponsorship_mutation_receipts, except
-- the side effect is external (Resend), so a request reserves its key first:
--   pending   reserved; the Resend draft is being created, or an attempt
--             ended without knowing whether Resend created it
--   created   Resend created the draft; broadcast_id/response_json recorded
-- Only a definite rejection from Resend (a 4xx) deletes the reservation. Any
-- other failure leaves it pending, and the next attempt settles it from
-- Resend's broadcast list: each draft's name carries a reference derived from
-- (actor_user_id, idempotency_key), so a draft Resend did create is found and
-- recorded instead of created again. See createResendDraft in
-- functions/_lib/domain/message-draft.js.
-- fingerprint is a SHA-256 of the draft content; the same key with different
-- content is refused. These are drafts only: nothing here records a send.
CREATE TABLE message_draft_receipts (
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'created')),
  broadcast_id TEXT,
  response_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (actor_user_id, idempotency_key)
);
