-- Blog posts written and published from /admin (Blog section). Published rows
-- are served at /blog/<slug> by the worker and listed by GET /api/blog/posts
-- alongside the file-based posts in public/blog/posts.json, which keep
-- working unchanged. Slugs must not collide with a file-based post; that is
-- checked when a post is saved (the files are not in the database).
--
--   body        the post in the admin message format (functions/_shared/message-format.js)
--   status      'draft' (only admins see it) or 'published' (public)
--   post_date   the date shown on the post (YYYY-MM-DD, Pacific), set on first publish
--   revision    optimistic concurrency: a save must name the revision it edited
--
-- Publishing is the human approval step for this public content; publish and
-- unpublish (and edits to a live post) are written to audit_events.
CREATE TABLE blog_posts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published')),
  post_date TEXT,
  published_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by_user_id TEXT REFERENCES users(id),
  updated_by_user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_blog_posts_status_date ON blog_posts(status, post_date DESC);
