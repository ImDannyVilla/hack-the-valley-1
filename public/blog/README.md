# Blog authoring guide

There are two ways to publish a post. Both appear together on `/blog/`.

- **From admin (easiest).** Open `/admin` → Blog → New post. Write it, click
  Preview to see the real page, then Publish. It is live at `/blog/<slug>` right
  away, with no PR or deploy, and you can edit or unpublish it later. Images can
  be dropped or pasted into the editor.
- **As a file in the repo** (this guide). Useful for hand-built pages; it needs a
  PR and a deploy. File-based posts show as read-only in admin.

## Add a new post

1. **Copy the template.** Duplicate `welcome-to-the-hack-the-valley-blog/index.html` into a
   new folder named after the post slug:

   ```
   public/blog/<slug>/index.html
   ```

   The post will be served at `/blog/<slug>`.

2. **Edit the content.** Update the `<title>`, the `<meta name="description">`, the
   `<!-- POST:META -->` header (date + title), and the article body between
   `<!-- POST:START -->` and `<!-- POST:END -->`. Write plain HTML (`<p>`, `<h2>`,
   `<ul>`, `<a>`, `<img>`); the `.post-body` styles handle the rest.

3. **Keep the CTA.** Leave the `<!-- CTA:START --> … <!-- CTA:END -->` block at the bottom
   of every post. It links to `/events` ("Sign up for our next event").

4. **Register it in the index.** Add an entry to `posts.json` (newest first is handled
   automatically — sorted by `date`):

   ```json
   {
     "slug": "<slug>",
     "title": "...",
     "description": "...",
     "excerpt": "Short teaser shown on the blog index.",
     "date": "YYYY-MM-DD"
   }
   ```

## Why the markers?

- `<!-- POST:START -->` … `<!-- POST:END -->` delimit the article body so the admin email
  composer ("Start from" a post, via `GET /api/admin/message-drafts/blog-post`) can reuse the exact
  post content without pulling in the nav, footer, or CTA chrome.
- `<!-- CTA:START -->` … `<!-- CTA:END -->` mark the "next event" call to action that
  every post must carry.
- Emails add their own platform-owned CTA block automatically. The email
  renderer always appends an upcoming-events button plus: "Want to highlight
  something on the Hack the Valley blog? Reply to this email..." so authors do not
  have to remember this per post.

Preview locally with `npm run dev`, then visit `/blog/`.
