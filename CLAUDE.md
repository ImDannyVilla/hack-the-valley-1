# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hack the Valley 2026 is a static landing page for a 50+ student one-day hackathon event in Bakersfield, California on May 30, 2026. The site is deployed as a Cloudflare Worker + Assets app using Wrangler.

## Development

Follow the canonical repository instructions in [`AGENTS.md`](AGENTS.md). The short local path is:

```bash
npm ci
npm test
npm run check
npm run db:migrations:check
cp .dev.vars.example .dev.vars
npm run db:bootstrap:local
npm run dev
```

Do not use remote D1, production credentials, or deploy commands for local acceptance.

**Deploy to Cloudflare:**
```bash
npm run deploy
```

## Event signup platform

The `/events` page is the canonical events surface. It combines the existing event archive with dynamic upcoming events from the event/signup backend.

- Event/signup API lives under `/api/events` and stores records in app D1 binding `HTV_DB` / database `hack-the-valley`.
- Admin UI lives at `/admin` and event create/export actions require an `htv_session` user with an active global `admin` or `super_admin` role. Legacy `/admin-events.html` redirects to `/admin`.
- Public signups sync opted-in emails to Resend using `RESEND_API_KEY`; per-event signup history lives in `HTV_DB`.
- Do not create a separate root `/events.html`; preserve the existing `/events` information architecture.

## Submissions portal

The project submission flow lives on `/submit` with a private admin review page at `/admin-submissions`.

- Uploads go to R2 through `/api/upload`.
- Submission metadata goes to D1 through `HTV_DB`.
- Admin media access goes through `/api/media`; legacy token access is kept for submissions/recovery paths, while the main admin surface is session + roles based.
- Full Cloudflare setup/deploy instructions are in `SUBMISSIONS-DEPLOYMENT.md`.

## Blog

Posts come from two places, and readers see one blog at `/blog/`:

- **Written in admin (the easy path).** `/admin` → Blog: write the post in the shared message editor (headings, links, bold, images; no personalized fields), preview it as the real page, and Publish. It is live at `/blog/<slug>` immediately, with no PR or deploy. Stored in `blog_posts` (migration `0032`) in the message format (`functions/_shared/message-format.js`).
- **File-based (in the repo).** `public/blog/<slug>/index.html` plus an entry in `public/blog/posts.json`; see `public/blog/README.md`. Article bodies are wrapped in `<!-- POST:START -->`/`<!-- POST:END -->` markers, and every post carries a "Sign up for our next event" CTA linking to `/events`. These are served directly as static assets and are read-only in admin.
- `functions/_lib/domain/blog-post.js` is the `BlogPost` (a `ContentItem` in `docs/domain-model.md`). It hides where a post lives: `loadBlogPost` (published admin post or file post; never drafts), `listPublishedBlogPosts` (both sources, newest first), `body()`, `webUrl()`, `toPageHtml()`, `broadcastName()`. It also owns the admin write rules: `saveBlogPost` (client-made id `post_<32 hex>`; every save names the `revision` it edited, so a retry with the same content returns the stored post and a stale save is a 409; slugs are unique across both sources; personalized fields are refused; the URL is locked after first publish), `publishBlogPost` / `unpublishBlogPost` (idempotent; the post keeps the Pacific date of its first publish). Publishing is the human approval for this public content: publish, unpublish, and edits to a live post are written to `audit_events`. Any admin (`admin` or `super_admin`) can publish.
- Routes stay thin: `GET /api/admin/blog-posts` (admin + file posts), `GET|PUT /api/admin/blog-posts/:id`, `POST /api/admin/blog-posts/:id/publish|unpublish`, `POST /api/admin/blog-posts/preview` (renders unsaved content), and public `GET /api/blog/posts` (what `/blog/` lists). `/blog/<slug>` for an admin post is rendered by `worker.js` (a slug with no static file falls through from the asset store) using `functions/_shared/blog-page.js`, whose nav, CTA, and footer a test keeps identical to the file-based template.
- The admin UI is `public/admin-blog-posts.js`; the editor itself is `public/admin-message-editor.js`, shared with the email composer.
- Emailing a post: in `/admin` → Email, pick it under "Start from" (lists both sources via `/api/blog/posts`). `GET /api/admin/message-drafts/blog-post?slug=` returns the post's title and body through `loadBlogPost`; the composer turns it into the editable message format, and the email links back to the post ("Read this on the web"). See "Email" below.
- History: posts used to be scheduled and sent from admin through `POST /api/blog/broadcast`, logged in the `blog_broadcast_sends` table (migration `0025`), and reconciled against Resend by the daily cron. That path was removed after admin became draft-only. The table and its rows remain as history only; a test checks that no code reads or writes it. Dropping it would be a separate, approved migration.

## Email

All admin email is written in the "Email" section of `/admin` ("Email draft"): a blank message, or one started from a blog post. In `docs/domain-model.md` terms this is a `MessageDraft`; a blog post it starts from is a `ContentItem`.

- `functions/_lib/domain/message-draft.js` is the `MessageDraft` domain object. It owns the rules: subject/message required within limits, an optional source post (`postSlug`, which must exist) that the email links back to ("Read this on the web"), rendering (`toEmailHtml`), the Resend broadcast name, image rules, and creating the Resend draft. Routes under `functions/api/admin/message-drafts/` stay thin (auth → `MessageDraft.fromInput` → delegate).
- Audience: every draft is addressed to the Resend segment in `RESEND_ALL_CONTACTS_SEGMENT_ID` (General, HTV's updates audience; its contacts are real recipients). There is no name-based or placeholder fallback. `GET /api/admin/message-drafts/audience` (admin) returns its name and current contact/subscribed counts, which the composer shows under "Goes to" before a draft is created; a create must name that `segmentId` or it is refused (409).
- `POST /api/admin/message-drafts` (`{ subject, heading?, message, postSlug?, segmentId, dryRun? }`, admin session + roles). `dryRun` returns the rendered email. Otherwise `createResendDraft` creates a Resend draft at most once per `Idempotency-Key` header: the key is reserved in `message_draft_receipts` (migration `0031`) before calling Resend, the draft's name carries a reference derived from the key (`Email: <subject> · ref <12 hex>`), then the result is recorded. A retry with the same key and content replays the recorded draft (`replayed: true`); the same key with different content is a 409. Only a definite rejection from Resend (a 4xx) releases the key. No answer, a 5xx, a lost response, or failing to record the id leaves it pending, and the next attempt settles it from Resend's broadcast list: a draft carrying the reference is recorded and replayed; if none exists after `PENDING_SETTLE_AFTER_MS` (5 minutes), the key is released and the draft created. Resend has no idempotency for creating broadcasts, so this table is the guard. The composer keeps one key per draft content (via `public/admin-idempotency.js`, shared with sponsorships), so re-submitting unchanged content never duplicates. It never sends or schedules: review the draft and send it in Resend.
- Message formatting lives in `functions/_shared/message-format.js`: blank lines make paragraphs, `- ` lines make bullets, `## `/`### ` lines make headings, a whole `![alt](url)` line is an image (optionally `{width=N}`, clamped to 80–552px), `[text](url)` makes a link, `**text**` is bold, bare http(s) URLs become links, and everything else is escaped. Image and link targets must be http(s) or root-relative. Resend contact fields (`{{{contact.first_name|there}}}`, `{{{contact.last_name}}}`, `{{{contact.email}}}`) pass through. The email chrome is `functions/_shared/email-template.js`.
- The composer is `public/admin-message-draft.js` (an ES module loaded by `admin.html`) on top of the shared editor `public/admin-message-editor.js`. The message box is a contenteditable editor: fields appear as chips (click or drag them from the Insert bar), images as previews with Small/Medium/Full and a width slider, pasted or dropped images upload automatically, and posts loaded with "Start from" (`GET /api/admin/message-drafts/blog-post?slug=`) keep their headings, links, and bold text (`htmlToMessage`). `serializeEditor` converts the editor back to the plain-text format above, so the server never receives editor HTML. Its field and width constants are kept in sync with the server by tests. The preview fills fields with a sample contact (`PREVIEW_CONTACT`, Alex Rivera) so it reads like a real inbox; the real email keeps the tokens.
- Images: the composer resizes to 1200px wide and converts non-PNG/GIF images (e.g. WebP, which Outlook skips) to JPEG, then uploads to `POST /api/admin/message-drafts/images` (admin only; PNG/JPEG/GIF up to 5MB, checked by content type and file signature). Files are named from a SHA-256 of their content (`img_<16 hex>.<ext>`), so re-uploading the same image is idempotent: same URL, no second copy. They live in the `SUBMISSIONS_MEDIA` R2 bucket under `email-images/` and are served publicly by `GET /api/email-images/<name>`, which only resolves those generated names. Files are not deleted when removed from a draft, because sent emails keep pointing at them.
- Resend calls live only in `functions/_shared/resend-broadcasts.js`: `resolveBroadcastConfig`, `fetchDraftAudience`, `createBroadcast` (its errors say whether the draft may exist: `created: false` for a 4xx, `null` otherwise; it gives up after 15 seconds), and `findBroadcast` (by the reference in a draft's name). Env: `RESEND_API_KEY`, `RESEND_BROADCAST_FROM` (a verified sender, no fallback to the login sender), `RESEND_ALL_CONTACTS_SEGMENT_ID` (required), optional `RESEND_BROADCAST_REPLY_TO`, and optional `SITE_BASE_URL` for absolute links/images (defaults to the request origin).

## Architecture

Static site with Cloudflare Worker + Assets API routes:
- Static files live in `public/`
- `worker.js` routes deployed `/api/*` requests to files under `functions/api/`
- Tailwind CSS via CDN
- Cloudflare Worker + Assets hosting

## Brand Guidelines

- **Colors:** Tech Blue (#2563eb), Dark Navy (#1e293b), Cyan (#06b6d4), Orange (#f59e0b)
- **Fonts:** Inter (headings and body)
- **Tone:** Energetic, innovative, community-focused
- **Identity:** Bakersfield, Central Valley tech community, student innovation
