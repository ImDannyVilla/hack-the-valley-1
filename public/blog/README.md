# Blog authoring guide

The blog is a manual list of static HTML pages. No build step, no database.

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
  composer ("Start from" a post, via `GET /api/admin/quick-email/post`) can reuse the exact
  post content without pulling in the nav, footer, or CTA chrome.
- `<!-- CTA:START -->` … `<!-- CTA:END -->` mark the "next event" call to action that
  every post must carry.
- Emails add their own platform-owned CTA block automatically. The email
  renderer always appends an upcoming-events button plus: "Want to highlight
  something on the Hack the Valley blog? Reply to this email..." so authors do not
  have to remember this per post.

Preview locally with `npm run dev`, then visit `/blog/`.
