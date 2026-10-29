// Blog post page: pure rendering of an admin-written post as a full page at
// /blog/<slug>, matching the file-based posts in public/blog/ (same head,
// nav, "Sign up for our next event" block, and footer; a test keeps them in
// sync with public/blog/welcome-to-the-hack-the-valley-blog/index.html).
// No database and no knowledge of how posts are stored.

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// "2026-10-29" -> "October 29, 2026"
export function formatPostDate(date) {
  const value = String(date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  return new Date(`${value}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export function renderBlogPostPage({ title, description = '', date = null, bodyHtml = '', draft = false } = {}) {
  const safeTitle = escapeHtml(title || 'Hack the Valley blog');
  const safeDescription = escapeHtml(description || '');
  const dateLabel = escapeHtml(formatPostDate(date) || (draft ? 'Draft preview' : ''));
  return `<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle} | Hack the Valley</title>
  <meta name="description" content="${safeDescription}">
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            "bc-blue": "#2563eb",
            "bc-navy": "#1e293b",
            "bc-cyan": "#06b6d4",
            "bc-orange": "#f59e0b",
            "bc-purple": "#7c3aed",
            "bc-dark": "#0f172a"
          },
          fontFamily: { sans: ["Inter", "sans-serif"] }
        }
      }
    };
  </script>
  <style>
    body { font-family: "Inter", sans-serif; }
    /* Article prose styling — applies inside .post-body so post HTML stays clean. */
    .post-body > * + * { margin-top: 1.25rem; }
    .post-body h2 { font-size: 1.875rem; line-height: 2.25rem; font-weight: 800; margin-top: 2.5rem; }
    .post-body h3 { font-size: 1.375rem; line-height: 1.875rem; font-weight: 700; margin-top: 2rem; }
    .post-body p, .post-body li { color: #cbd5e1; font-size: 1.125rem; line-height: 1.85rem; }
    .post-body a { color: #22d3ee; text-decoration: underline; }
    .post-body a:hover { color: #67e8f9; }
    .post-body ul { list-style: disc; padding-left: 1.5rem; }
    .post-body ol { list-style: decimal; padding-left: 1.5rem; }
    .post-body img { display: block; margin: 0 auto; max-width: 100%; height: auto; border-radius: 1rem; border: 1px solid #334155; }
  </style>
</head>
<body class="bg-bc-dark text-slate-100">
  <nav class="sticky top-0 z-50 bg-bc-dark/90 backdrop-blur-sm border-b border-slate-800">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="h-16 flex items-center justify-between gap-6">
        <a href="/" class="flex items-center gap-4 min-w-0">
          <img src="/images/HackTheValleyLogo.PNG" alt="Hack the Valley logo" class="w-12 h-12 object-contain rounded-full">
          <span class="font-bold text-lg sm:text-xl truncate">Hack the Valley</span>
        </a>
        <div data-participant-nav class="hidden md:flex items-center gap-2 text-sm font-bold">
          <a data-nav-link="events" href="/events" class="rounded-full px-3 py-2 text-slate-300 hover:bg-slate-800 hover:text-bc-cyan transition">Events</a>
          <a data-nav-link="projects" href="/projects/" class="rounded-full px-3 py-2 text-slate-300 hover:bg-slate-800 hover:text-bc-cyan transition">Projects</a>
          <a data-nav-link="blog" href="/blog/" aria-current="page" class="rounded-full bg-bc-cyan/15 px-3 py-2 text-bc-cyan ring-1 ring-bc-cyan/40">Blog</a>
          <a data-nav-link="profile" href="/me/" class="rounded-full px-3 py-2 text-slate-300 hover:bg-slate-800 hover:text-bc-cyan transition">Profile</a>
          <a data-nav-link="leaderboard" href="/leaderboard/" class="rounded-full px-3 py-2 text-slate-300 hover:bg-slate-800 hover:text-bc-cyan transition">Leaderboard</a>
        </div>
      </div>
      <div class="pb-3 md:hidden flex gap-3 overflow-x-auto text-sm whitespace-nowrap font-bold">
        <a href="/events" class="rounded-full px-3 py-2 text-slate-300">Events</a>
        <a href="/projects/" class="rounded-full px-3 py-2 text-slate-300">Projects</a>
        <a href="/blog/" aria-current="page" class="rounded-full bg-bc-cyan/15 px-3 py-2 text-bc-cyan ring-1 ring-bc-cyan/40">Blog</a>
        <a href="/me/" class="rounded-full px-3 py-2 text-slate-300">Profile</a>
        <a href="/leaderboard/" class="rounded-full px-3 py-2 text-slate-300">Leaderboard</a>
      </div>
    </div>
  </nav>

  <main class="py-14 sm:py-20">
    <article class="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
      <a href="/blog/" class="text-sm text-bc-cyan font-semibold hover:text-cyan-300">← All posts</a>

      <header class="mt-6 mb-10">
        <p class="text-sm text-bc-cyan font-semibold mb-3">${dateLabel}</p>
        <h1 class="text-4xl sm:text-5xl font-black leading-tight">${safeTitle}</h1>
      </header>

      <div class="post-body">
        ${bodyHtml}
      </div>

      <!-- CTA:START — "Sign up for our next event" call to action. Keep this block on every post. -->
      <aside class="mt-14 bg-bc-navy border border-slate-700 rounded-3xl p-8 sm:p-10 text-center shadow-2xl shadow-bc-cyan/10">
        <p class="text-bc-cyan uppercase tracking-widest text-sm font-bold mb-3">Don't miss the next one</p>
        <h2 class="text-3xl sm:text-4xl font-black mb-4">Sign up for our next event.</h2>
        <p class="text-slate-300 max-w-xl mx-auto mb-7">Workshops, meetups, and the next hackathon — see what's coming up and grab your spot.</p>
        <a href="/events" class="inline-block bg-bc-cyan text-bc-dark px-8 py-4 rounded-lg text-lg font-bold hover:bg-cyan-400 transition">Sign up for our next event</a>
      </aside>
      <!-- CTA:END -->
    </article>
  </main>

  <footer class="bg-slate-950 border-t border-slate-800 py-10">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-col md:flex-row gap-6 items-center justify-between text-sm text-slate-400">
      <div class="flex items-center gap-3">
        <img src="/images/HackTheValleyLogo.PNG" alt="Hack the Valley logo" class="w-10 h-10 rounded-full object-contain">
        <span>© 2026 Hack the Valley</span>
      </div>
      <div class="flex gap-5 flex-wrap justify-center">
        <a href="mailto:contact@hackthevalley.org" class="hover:text-white">contact@hackthevalley.org</a>
        <a href="/events" class="hover:text-white">Events</a>
        <a href="/blog/" class="hover:text-white">Blog</a>
        <a href="/projects/" class="hover:text-white">Projects</a>
      </div>
    </div>
  </footer>
</body>
</html>`;
}
