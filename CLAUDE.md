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

The blog is a manual list of static HTML pages under `public/blog/` (no database, no build step). See `public/blog/README.md` for how to author a post.

- The index at `/blog/` renders cards from `public/blog/posts.json`.
- Each post is `public/blog/<slug>/index.html`, served at `/blog/<slug>`. Article bodies are wrapped in `<!-- POST:START -->`/`<!-- POST:END -->` markers, and every post carries a "Sign up for our next event" CTA linking to `/events`.
- Emailing a post: in `/admin` → Email, pick the post under "Start from". `GET /api/admin/quick-email/post?slug=` (admin session + roles) returns the post's title and body through `loadBlogPost`; the composer turns it into the editable message format, and the email links back to the post ("Read this on the web"). See "Email" below.
- Code structure follows the domain pattern. `functions/_lib/domain/blog-post.js` is the `BlogPost`: it loads a published post via `loadBlogPost` and owns `body()`, `webUrl()`, and `broadcastName()`. The HTML-comment body markers are a private implementation detail hidden inside it, so the storage format can be swapped without touching callers.
- History: posts used to be scheduled and sent from admin through `POST /api/blog/broadcast`, logged in the `blog_broadcast_sends` table (migration `0025`), and reconciled against Resend by the daily cron. That path was removed after admin became draft-only. The table and its rows remain as history only; a test checks that no code reads or writes it. Dropping it would be a separate, approved migration.

## Email

All admin email is written in the "Email" section of `/admin` ("Email draft"): a blank message, or one started from a blog post.

- `POST /api/admin/quick-email` (`{ subject, heading?, message, postSlug?, dryRun? }`, admin session + roles required) renders the plain-text message inside the shared email chrome (`functions/_shared/blog-broadcast.js`) and creates a Resend draft. `postSlug` marks an email started from a post: the post must exist, the email gets a "Read this on the web" link, and the Resend broadcast is named after the post. It never sends or schedules: review recipients and send in Resend.
- Message formatting lives in `functions/_shared/quick-email.js`: blank lines make paragraphs, `- ` lines make bullets, `## `/`### ` lines make headings, a whole `![alt](url)` line is an image (optionally `{width=N}`, clamped to 80–552px), `[text](url)` makes a link, `**text**` is bold, bare http(s) URLs become links, and everything else is escaped. Image and link targets must be http(s) or root-relative. Resend contact fields (`{{{contact.first_name|there}}}`, `{{{contact.last_name}}}`, `{{{contact.email}}}`) pass through.
- The composer is `public/admin-quick-email.js` (an ES module loaded by `admin.html`). The message box is a contenteditable editor: fields appear as chips (click or drag them from the Insert bar), images as previews with Small/Medium/Full and a width slider, pasted or dropped images upload automatically, and posts loaded with "Start from" keep their headings, links, and bold text (`htmlToMessage`). `serializeEditor` converts the editor back to the plain-text format above before preview or draft, so the server never receives editor HTML. Its field and width constants are kept in sync with the server by tests. The preview fills fields with a sample contact (`PREVIEW_CONTACT`, Alex Rivera) so it reads like a real inbox; the real email keeps the tokens.
- Images: the composer resizes to 1200px wide, converts non-PNG/GIF images (e.g. WebP, which Outlook skips) to JPEG, and uploads to `POST /api/admin/quick-email/images` (admin only; PNG/JPEG/GIF up to 5MB, checked by content type and file signature). They are stored in the `SUBMISSIONS_MEDIA` R2 bucket under `email-images/` and served publicly by `GET /api/email-images/<name>`, which only resolves generated `img_<hex>.<ext>` names so it cannot expose other objects in the bucket.
- Draft creation goes through `createDraftEmail` (`functions/_lib/domain/blog-broadcast.js`), which resolves the sender, reply-to, and a safe draft placeholder segment (`RESEND_BROADCAST_DRAFT_SEGMENT_ID`, or one existing General/Draft/Test segment). Env: `RESEND_API_KEY`, `RESEND_BROADCAST_FROM` (a verified sender, no fallback to the login sender), optional `RESEND_BROADCAST_REPLY_TO`, and optional `SITE_BASE_URL` for absolute links/images (defaults to the request origin).

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
