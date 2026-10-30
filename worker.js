import { runScheduledSponsorshipReminders } from './functions/_lib/domain/sponsorship-reminders.js';
import * as adminSponsorships from './functions/api/admin/sponsorships/index.js';
import * as eventSignups from './functions/api/events/[slug]/signups/index.js';
import * as adminMe from './functions/api/admin/me.js';
import * as adminRoles from './functions/api/admin/roles.js';
import * as adminWorkflows from './functions/api/admin/workflows.js';
import * as adminAudit from './functions/api/admin/audit.js';
import * as adminPhysicalResources from './functions/api/admin/physical-resources/index.js';
import * as adminPhysicalResource from './functions/api/admin/physical-resources/[id].js';
import * as adminEventPlans from './functions/api/admin/event-plans/index.js';
import * as adminEventPlan from './functions/api/admin/event-plans/[id].js';
import * as authRequestCode from './functions/api/auth/request-code.js';
import * as authVerifyCode from './functions/api/auth/verify-code.js';
import * as authMagicLogin from './functions/api/auth/magic-login.js';
import * as authLogout from './functions/api/auth/logout.js';
import * as me from './functions/api/me.js';
import * as meProjects from './functions/api/me/projects.js';
import * as eventCheckins from './functions/api/events/[slug]/checkins/index.js';
import * as eventCockpit from './functions/api/events/[slug]/instances/[instanceId]/cockpit/index.js';
import * as eventFollowup from './functions/api/events/[slug]/instances/[instanceId]/followup/index.js';
import * as eventProjects from './functions/api/events/[slug]/instances/[instanceId]/projects/index.js';
import * as eventProjectsIndex from './functions/api/events/[slug]/projects/index.js';
import * as eventProjectStatus from './functions/api/events/[slug]/projects/[projectId].js';
import * as eventPhotos from './functions/api/events/[slug]/instances/[instanceId]/photos/index.js';
import * as eventImage from './functions/api/events/[slug]/image.js';
import * as eventSlug from './functions/api/events/[slug].js';
import * as eventsIndex from './functions/api/events/index.js';
import * as media from './functions/api/media.js';
import * as leaderboard from './functions/api/leaderboard.js';
import * as projectsPublic from './functions/api/projects.js';
import * as projectsMedia from './functions/api/projects/media.js';
import * as register from './functions/api/register.js';
import * as submissions from './functions/api/submissions.js';
import * as subscribe from './functions/api/subscribe.js';
import * as helperInterest from './functions/api/helper-interest.js';
import * as adminMessageDrafts from './functions/api/admin/message-drafts/index.js';
import * as adminMessageDraftImages from './functions/api/admin/message-drafts/images.js';
import * as adminMessageDraftBlogPost from './functions/api/admin/message-drafts/blog-post.js';
import * as adminMessageDraftAudience from './functions/api/admin/message-drafts/audience.js';
import * as adminMessageDraftSend from './functions/api/admin/message-drafts/send.js';
import * as adminMessageDraftTest from './functions/api/admin/message-drafts/test.js';
import * as emailImage from './functions/api/email-images/[name].js';
import * as adminBlogPosts from './functions/api/admin/blog-posts/index.js';
import * as adminBlogPostPreview from './functions/api/admin/blog-posts/preview.js';
import * as adminBlogPost from './functions/api/admin/blog-posts/[id].js';
import * as blogPosts from './functions/api/blog/posts.js';
import { loadBlogPost } from './functions/_lib/domain/blog-post.js';
import { getDb, getEvent, handleErrors, listEventInstances, listPublishedEventPhotos, renderEventPageHtml } from './functions/_lib/event-platform.js';
import * as upload from './functions/api/upload.js';
import * as users from './functions/api/users/index.js';
import * as userBadges from './functions/api/users/[id]/badges.js';
import * as userState from './functions/api/users/[id]/state.js';
import { corsHeaders } from './functions/_shared/submissions.js';

const API_ROUTES = {
  '/api/media': media,
  '/api/leaderboard': leaderboard,
  '/api/leaderboard/': leaderboard,
  '/api/me': me,
  '/api/me/projects': meProjects,
  '/api/projects': projectsPublic,
  '/api/register': register,
  '/api/submissions': submissions,
  '/api/subscribe': subscribe,
  '/api/helper-interest': helperInterest,
  '/api/blog/posts': blogPosts,
  '/api/upload': upload,
  '/api/users': users,
};

function methodHandlerName(method) {
  const normalized = String(method || '').toLowerCase();
  return `onRequest${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

function methodNotAllowed(routeModule) {
  const methods = Object.keys(routeModule)
    .filter((key) => key.startsWith('onRequest'))
    .map((key) => key.replace('onRequest', '').toUpperCase())
    .filter((method) => method !== 'OPTIONS')
    .sort();

  const headers = new Headers(corsHeaders());
  headers.set('content-type', 'application/json; charset=utf-8');
  if (methods.length) headers.set('allow', methods.join(', '));
  return new Response(JSON.stringify({ ok: false, error: 'Method not allowed.' }), {
    status: 405,
    headers,
  });
}

async function routeApiRequest(request, env, ctx, routeModule, params = {}) {
  const handler = routeModule[methodHandlerName(request.method)];
  if (!handler) return methodNotAllowed(routeModule);

  return handler({
    request,
    env,
    params,
    waitUntil: ctx?.waitUntil?.bind(ctx),
    passThroughOnException: ctx?.passThroughOnException?.bind(ctx),
    next: () => env?.ASSETS?.fetch(request),
    data: {},
  });
}

function matchApiRoute(pathname) {
  if (pathname === '/api/admin/sponsorships' || pathname.startsWith('/api/admin/sponsorships/')) {
    return { routeModule: adminSponsorships, params: {} };
  }

  if (pathname === '/api/events') {
    return { routeModule: eventsIndex, params: {} };
  }

  if (pathname === '/api/admin/me') {
    return { routeModule: adminMe, params: {} };
  }

  if (pathname === '/api/admin/roles') {
    return { routeModule: adminRoles, params: {} };
  }

  if (pathname === '/api/admin/workflows') {
    return { routeModule: adminWorkflows, params: {} };
  }

  if (pathname === '/api/admin/audit') {
    return { routeModule: adminAudit, params: {} };
  }

  if (pathname === '/api/admin/message-drafts') {
    return { routeModule: adminMessageDrafts, params: {} };
  }

  if (pathname === '/api/admin/message-drafts/images') {
    return { routeModule: adminMessageDraftImages, params: {} };
  }

  if (pathname === '/api/admin/message-drafts/blog-post') {
    return { routeModule: adminMessageDraftBlogPost, params: {} };
  }

  if (pathname === '/api/admin/message-drafts/audience') {
    return { routeModule: adminMessageDraftAudience, params: {} };
  }

  if (pathname === '/api/admin/message-drafts/send') {
    return { routeModule: adminMessageDraftSend, params: {} };
  }

  if (pathname === '/api/admin/message-drafts/test') {
    return { routeModule: adminMessageDraftTest, params: {} };
  }

  if (pathname === '/api/admin/blog-posts' || pathname === '/api/admin/blog-posts/') {
    return { routeModule: adminBlogPosts, params: {} };
  }

  if (pathname === '/api/admin/blog-posts/preview') {
    return { routeModule: adminBlogPostPreview, params: {} };
  }

  const adminBlogPostMatch = pathname.match(/^\/api\/admin\/blog-posts\/([^/]+?)(?:\/(publish|unpublish))?\/?$/);
  if (adminBlogPostMatch) {
    return { routeModule: adminBlogPost, params: { id: decodeURIComponent(adminBlogPostMatch[1]), action: adminBlogPostMatch[2] || null } };
  }

  const emailImageMatch = pathname.match(/^\/api\/email-images\/([^/]+)$/);
  if (emailImageMatch) {
    return { routeModule: emailImage, params: { name: decodeURIComponent(emailImageMatch[1]) } };
  }

  if (pathname === '/api/admin/physical-resources' || pathname === '/api/admin/physical-resources/') {
    return { routeModule: adminPhysicalResources, params: {} };
  }

  if (pathname === '/api/admin/event-plans' || pathname === '/api/admin/event-plans/') {
    return { routeModule: adminEventPlans, params: {} };
  }

  const adminEventPlanMatch = pathname.match(/^\/api\/admin\/event-plans\/([^/]+)\/?$/);
  if (adminEventPlanMatch) {
    return { routeModule: adminEventPlan, params: { id: decodeURIComponent(adminEventPlanMatch[1]) } };
  }

  const adminPhysicalResourceMatch = pathname.match(/^\/api\/admin\/physical-resources\/([^/]+)(?:\/(checkouts|photo))?\/?$/);
  if (adminPhysicalResourceMatch) {
    return { routeModule: adminPhysicalResource, params: { id: decodeURIComponent(adminPhysicalResourceMatch[1]), action: adminPhysicalResourceMatch[2] } };
  }

  if (pathname === '/api/auth/request-code') {
    return { routeModule: authRequestCode, params: {} };
  }

  if (pathname === '/api/auth/verify-code') {
    return { routeModule: authVerifyCode, params: {} };
  }

  if (pathname === '/api/auth/magic-login') {
    return { routeModule: authMagicLogin, params: {} };
  }

  if (pathname === '/api/auth/logout') {
    return { routeModule: authLogout, params: {} };
  }

  if (pathname === '/api/projects/media') {
    return { routeModule: projectsMedia, params: {} };
  }

  const publicProjectApiMatch = pathname.match(/^\/api\/projects\/([^/]+)\/([^/]+)\/?$/);
  if (publicProjectApiMatch) {
    return { routeModule: projectsPublic, params: { eventSlug: decodeURIComponent(publicProjectApiMatch[1]), projectSlug: decodeURIComponent(publicProjectApiMatch[2]) } };
  }

  const meProjectMaterialsMatch = pathname.match(/^\/api\/me\/projects\/([^/]+)\/materials\/?$/);
  if (meProjectMaterialsMatch) {
    return { routeModule: meProjects, params: { projectId: decodeURIComponent(meProjectMaterialsMatch[1]), action: 'materials' } };
  }

  const meProjectMediaMatch = pathname.match(/^\/api\/me\/projects\/([^/]+)\/media\/?$/);
  if (meProjectMediaMatch) {
    return { routeModule: meProjects, params: { projectId: decodeURIComponent(meProjectMediaMatch[1]), action: 'media' } };
  }

  const meProjectSubmissionMatch = pathname.match(/^\/api\/me\/projects\/([^/]+)\/submissions\/?$/);
  if (meProjectSubmissionMatch) {
    return { routeModule: meProjects, params: { projectId: decodeURIComponent(meProjectSubmissionMatch[1]), action: 'submissions' } };
  }

  const meProjectMatch = pathname.match(/^\/api\/me\/projects\/([^/]+)\/?$/);
  if (meProjectMatch) {
    return { routeModule: meProjects, params: { projectId: decodeURIComponent(meProjectMatch[1]) } };
  }

  const signupMatch = pathname.match(/^\/api\/events\/([^/]+)\/signups\/?$/);
  if (signupMatch) {
    return { routeModule: eventSignups, params: { slug: decodeURIComponent(signupMatch[1]) } };
  }

  const checkinMatch = pathname.match(/^\/api\/events\/([^/]+)\/checkins\/?$/);
  if (checkinMatch) {
    return { routeModule: eventCheckins, params: { slug: decodeURIComponent(checkinMatch[1]) } };
  }

  const cockpitMatch = pathname.match(/^\/api\/events\/([^/]+)\/instances\/([^/]+)\/cockpit\/?$/);
  if (cockpitMatch) {
    return { routeModule: eventCockpit, params: { slug: decodeURIComponent(cockpitMatch[1]), instanceId: decodeURIComponent(cockpitMatch[2]) } };
  }

  const followupMatch = pathname.match(/^\/api\/events\/([^/]+)\/instances\/([^/]+)\/followup\/?$/);
  if (followupMatch) {
    return { routeModule: eventFollowup, params: { slug: decodeURIComponent(followupMatch[1]), instanceId: decodeURIComponent(followupMatch[2]) } };
  }

  const projectsMatch = pathname.match(/^\/api\/events\/([^/]+)\/instances\/([^/]+)\/projects\/?$/);
  if (projectsMatch) {
    return { routeModule: eventProjects, params: { slug: decodeURIComponent(projectsMatch[1]), instanceId: decodeURIComponent(projectsMatch[2]) } };
  }

  const eventProjectsIndexMatch = pathname.match(/^\/api\/events\/([^/]+)\/projects\/?$/);
  if (eventProjectsIndexMatch) {
    return { routeModule: eventProjectsIndex, params: { slug: decodeURIComponent(eventProjectsIndexMatch[1]) } };
  }

  const eventProjectStatusMatch = pathname.match(/^\/api\/events\/([^/]+)\/projects\/([^/]+)\/?$/);
  if (eventProjectStatusMatch) {
    return { routeModule: eventProjectStatus, params: { slug: decodeURIComponent(eventProjectStatusMatch[1]), projectId: decodeURIComponent(eventProjectStatusMatch[2]) } };
  }

  const photosMatch = pathname.match(/^\/api\/events\/([^/]+)\/instances\/([^/]+)\/photos\/?$/);
  if (photosMatch) {
    return { routeModule: eventPhotos, params: { slug: decodeURIComponent(photosMatch[1]), instanceId: decodeURIComponent(photosMatch[2]) } };
  }

  const imageMatch = pathname.match(/^\/api\/events\/([^/]+)\/image\/?$/);
  if (imageMatch) {
    return { routeModule: eventImage, params: { slug: decodeURIComponent(imageMatch[1]) } };
  }

  const userStateMatch = pathname.match(/^\/api\/users\/([^/]+)\/state\/?$/);
  if (userStateMatch) {
    return { routeModule: userState, params: { id: decodeURIComponent(userStateMatch[1]) } };
  }

  const userBadgesMatch = pathname.match(/^\/api\/users\/([^/]+)\/badges\/?$/);
  if (userBadgesMatch) {
    return { routeModule: userBadges, params: { id: decodeURIComponent(userBadgesMatch[1]) } };
  }

  const eventMatch = pathname.match(/^\/api\/events\/([^/]+)\/?$/);
  if (eventMatch) {
    return { routeModule: eventSlug, params: { slug: decodeURIComponent(eventMatch[1]) } };
  }

  const routeModule = API_ROUTES[pathname];
  return routeModule ? { routeModule, params: {} } : null;
}

function isEventPagePath(pathname) {
  return /^\/events\/[^/.][^/]*\/?$/.test(pathname);
}

async function renderEventPage(request, env) {
  return handleErrors(async () => {
    if (env.ASSETS?.fetch) {
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status < 400) return assetResponse;
    }

    const url = new URL(request.url);
    const slug = decodeURIComponent(url.pathname.match(/^\/events\/([^/]+)\/?$/)?.[1] || "");
    const db = getDb(env);
    const event = await getEvent(db, slug);
    if (!event || event.status === "archived") {
      return new Response("Event not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    const instances = await listEventInstances(db, slug);
    const activeInstance = event.active_instance_id
      ? instances.find((instance) => instance.id === event.active_instance_id)
      : null;
    const datedInstancesNewestFirst = [...instances]
      .filter((instance) => instance.starts_at)
      .reverse();
    const displayInstance = activeInstance
      || datedInstancesNewestFirst.find((instance) => instance.status === "closed")
      || datedInstancesNewestFirst.find((instance) => instance.status !== "archived")
      || instances.find((instance) => instance.status !== "archived");
    const photos = displayInstance
      ? await listPublishedEventPhotos(db, slug, displayInstance.id)
      : [];
    return new Response(renderEventPageHtml(event, { photos }), {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
    });
  });
}

// /blog/<slug>: file-based posts are static assets and normally never reach
// the worker; a slug with no file lands here and is rendered from the
// published admin posts.
function isBlogPostPagePath(pathname) {
  return /^\/blog\/[a-z0-9-]+\/?$/.test(pathname);
}

async function renderBlogPostPage(request, env) {
  if (env.ASSETS?.fetch) {
    const assetResponse = await env.ASSETS.fetch(request);
    if (assetResponse.status < 400) return assetResponse;
  }
  const url = new URL(request.url);
  const slug = url.pathname.match(/^\/blog\/([a-z0-9-]+)\/?$/)[1];
  try {
    const post = await loadBlogPost(env.ASSETS, slug, { origin: url.origin, db: getDb(env) });
    return new Response(post.toPageHtml(), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error?.status === 404) {
      return new Response('Post not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    return handleErrors(async () => { throw error; });
  }
}

function isPublicProjectPagePath(pathname) {
  return /^\/projects\/[^/.][^/]*\/[^/.][^/]*\/?$/.test(pathname);
}

function isPhysicalResourceQrPath(pathname) {
  return /^\/resources\/[^/.][^/]*\/?$/.test(pathname);
}

function redirectPhysicalResourceQr(request) {
  const url = new URL(request.url);
  const resourceId = decodeURIComponent(url.pathname.match(/^\/resources\/([^/]+)\/?$/)?.[1] || "").trim();
  if (!resourceId) return new Response("Resource id required", { status: 400 });
  const destination = new URL("/admin", url);
  destination.searchParams.set("resource_id", resourceId);
  destination.hash = "physical-resource-form";
  return Response.redirect(destination, 302);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function renderPublicProjectPageHtml({ eventSlug, projectSlug, origin }) {
  const apiPath = `/api/projects/${encodeURIComponent(eventSlug)}/${encodeURIComponent(projectSlug)}`;
  const canonicalPath = `/projects/${encodeURIComponent(eventSlug)}/${encodeURIComponent(projectSlug)}/`;
  const canonicalUrl = `${origin}${canonicalPath}`;
  return `<!DOCTYPE html>
<html lang="en" class="scroll-smooth">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Project | Hack the Valley</title>
  <meta name="description" content="Public Hack the Valley project details with demo, repository, tracks, awards, and team context.">
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap" rel="stylesheet">
  <script>tailwind.config = { theme: { extend: { colors: { 'bc-dark': '#0f172a', 'bc-navy': '#1e293b', 'bc-cyan': '#22d3ee', 'bc-orange': '#f59e0b' }, fontFamily: { sans: ['Inter', 'sans-serif'] } } } }</script>
</head>
<body class="bg-bc-dark text-white font-sans">
  <header class="sticky top-0 z-50 bg-bc-dark/90 backdrop-blur-md border-b border-slate-700">
    <nav class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3" aria-label="Participant">
      <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <a href="/" class="flex items-center gap-3 min-w-0"><img src="/images/HackTheValleyLogo.PNG" alt="Hack the Valley" class="h-10 w-auto"><span class="font-black text-xl truncate">Hack the Valley</span></a>
        <div data-participant-nav class="flex flex-wrap items-center gap-2 text-sm font-bold">
          <a data-nav-link="events" href="/events" class="rounded-full px-3 py-2 text-slate-300 hover:bg-slate-800 hover:text-bc-cyan transition">Events</a>
          <a data-nav-link="projects" href="/projects/" aria-current="page" class="rounded-full bg-bc-cyan/15 px-3 py-2 text-bc-cyan ring-1 ring-bc-cyan/40">Projects</a>
          <a data-nav-link="blog" href="/blog/" class="rounded-full px-3 py-2 text-slate-300 hover:bg-slate-800 hover:text-bc-cyan transition">Blog</a>
          <a data-nav-link="profile" href="/me/" class="rounded-full px-3 py-2 text-slate-300 hover:bg-slate-800 hover:text-bc-cyan transition">Profile</a>
          <a data-nav-link="leaderboard" href="/leaderboard/" class="rounded-full px-3 py-2 text-slate-300 hover:bg-slate-800 hover:text-bc-cyan transition">Leaderboard</a>
        </div>
      </div>
    </nav>
  </header>
  <main class="min-h-screen">
    <section class="py-12 sm:py-16">
      <div class="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
        <a href="/projects/" class="text-sm font-bold text-bc-cyan hover:text-cyan-200">← Back to projects</a>
        <div id="project-error" class="hidden mt-8 rounded-2xl border border-red-500/40 bg-red-950/40 p-5 text-red-100"></div>
        <article id="project-detail" class="mt-8 rounded-3xl border border-slate-700 bg-bc-navy/70 p-6 sm:p-8 shadow-2xl shadow-black/20">
          <p class="text-slate-400">Loading public project…</p>
        </article>
      </div>
    </section>
  </main>
  <footer class="border-t border-slate-800 py-8 text-center text-sm text-slate-500"><p>Public project pages omit private contacts, admin notes, hidden submissions, emergency contacts, and non-public media.</p></footer>
  <script>
    const apiPath = ${JSON.stringify(apiPath)};
    const detail = document.querySelector('#project-detail');
    const errorBox = document.querySelector('#project-error');
    function escapeHtml(value) { return String(value ?? '').replace(/[&<>'\"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '\"': '&quot;' }[char])); }
    function eventDisplayName(eventSlug) {
      const slug = String(eventSlug || '').trim();
      if (!slug) return '';
      const lowerCaseWords = new Set(['a', 'an', 'and', 'at', 'for', 'in', 'of', 'on', 'or', 'the', 'to']);
      return slug.split(/[-_]+/).filter(Boolean).map((part, index) => /^\\d+$/.test(part) ? part : (index > 0 && lowerCaseWords.has(part.toLowerCase()) ? part.toLowerCase() : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())).join(' ');
    }
    function awardLabel(award, project) {
      const event = award.event || eventDisplayName(award.event_slug || project.event_slug);
      return award.display_text || (event ? (award.title || 'Award') + ' - ' + event : (award.title || 'Award'));
    }
    function heroMarkup(project) {
      const media = project.hero_media;
      if (!media?.url) return '';
      const fallbackAlt = (project.title || 'Project') + (media.kind === 'video' ? ' video' : ' image');
      if (media.kind === 'video') return '<div class="mb-8 overflow-hidden rounded-3xl border border-slate-700 bg-slate-950"><video class="max-h-[32rem] w-full object-contain" src="' + escapeHtml(media.url) + '" controls preload="metadata" aria-label="' + escapeHtml(media.alt || fallbackAlt) + '"></video></div>';
      return '<div class="mb-8 overflow-hidden rounded-3xl border border-slate-700 bg-slate-950"><img class="max-h-[32rem] w-full object-contain" src="' + escapeHtml(media.url) + '" alt="' + escapeHtml(media.alt || fallbackAlt) + '"></div>';
    }
    function linkMarkup(project) {
      const links = [];
      if (project.demo_url) links.push('<a href="' + escapeHtml(project.demo_url) + '" target="_blank" rel="noopener noreferrer" class="rounded-lg bg-bc-cyan px-4 py-2 font-black text-bc-dark hover:bg-cyan-300">Open demo</a>');
      if (project.repo_url) links.push('<a href="' + escapeHtml(project.repo_url) + '" target="_blank" rel="noopener noreferrer" class="rounded-lg border border-bc-cyan px-4 py-2 font-black text-bc-cyan hover:bg-bc-cyan/10">Repository</a>');
      return links.length ? '<div class="mt-8 flex flex-wrap gap-3">' + links.join('') + '</div>' : '';
    }
    function renderProject(project) {
      document.title = (project.title || 'Project') + ' | Hack the Valley';
      const tracks = Array.isArray(project.tracks) ? project.tracks : [];
      const awards = Array.isArray(project.awards) ? project.awards : [];
      const team = project.team_name ? '<p class="mt-3 text-sm uppercase tracking-[0.14em] text-slate-400 font-bold">' + escapeHtml(project.team_name) + '</p>' : '';
      const trackMarkup = tracks.map((track) => '<span class="rounded-full bg-bc-cyan/10 px-3 py-1 text-xs font-bold text-bc-cyan">' + escapeHtml(track) + '</span>').join('');
      const awardMarkup = awards.length ? '<div class="mt-5 flex flex-wrap gap-2">' + awards.map((award) => '<span class="inline-flex items-center rounded-full bg-bc-orange/15 border border-bc-orange/40 px-3 py-1 text-xs font-black text-bc-orange">' + escapeHtml(awardLabel(award, project)) + '</span>').join('') + '</div>' : '';
      detail.innerHTML = heroMarkup(project) + '<p class="text-bc-orange uppercase tracking-[0.2em] text-xs font-black mb-3">' + escapeHtml(eventDisplayName(project.event_slug)) + '</p><h1 class="text-4xl sm:text-5xl font-black leading-tight">' + escapeHtml(project.title || 'Untitled project') + '</h1>' + team + '<div class="mt-5 flex flex-wrap gap-2">' + trackMarkup + '</div>' + awardMarkup + '<p class="mt-8 text-lg leading-relaxed text-slate-200">' + escapeHtml(project.description || 'Project details coming soon.') + '</p>' + linkMarkup(project) + '<p class="mt-8 text-xs text-slate-500">Public showcase record. Contact details and organizer-only submission metadata are intentionally omitted.</p>';
    }
    async function loadProject() {
      try {
        const response = await fetch(apiPath, { headers: { Accept: 'application/json' } });
        const data = await response.json();
        if (!response.ok || data.ok === false) throw new Error(data.error || 'Could not load project.');
        renderProject(data.project || {});
      } catch (error) {
        detail.classList.add('hidden');
        errorBox.classList.remove('hidden');
        errorBox.textContent = error.message || 'Could not load public project.';
      }
    }
    loadProject();
  </script>
</body>
</html>`;
}

function renderPublicProjectPage(request) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/projects\/([^/]+)\/([^/]+)\/?$/);
  const eventSlug = decodeURIComponent(match?.[1] || '');
  const projectSlug = decodeURIComponent(match?.[2] || '');
  return new Response(renderPublicProjectPageHtml({ eventSlug, projectSlug, origin: url.origin }), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
  });
}

export default {
  async fetch(request, env = {}, ctx = {}) {
    const url = new URL(request.url);
    const route = matchApiRoute(url.pathname);

    if (route) {
      return routeApiRequest(request, env, ctx, route.routeModule, route.params);
    }

    if (url.pathname === '/demo-hours' || url.pathname === '/demo-hours/') {
      return Response.redirect(new URL('/events/demo-hours', url), 302);
    }

    if (url.pathname === '/submit' || url.pathname === '/submit/') {
      return Response.redirect(new URL('/me/projects/', url), 302);
    }

    if (isEventPagePath(url.pathname)) {
      return renderEventPage(request, env);
    }

    if (isBlogPostPagePath(url.pathname)) {
      return renderBlogPostPage(request, env);
    }

    if (isPhysicalResourceQrPath(url.pathname)) {
      return redirectPhysicalResourceQr(request);
    }

    if (isPublicProjectPagePath(url.pathname)) {
      return renderPublicProjectPage(request);
    }

    if (env.ASSETS?.fetch) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },

  // Cron (see wrangler.toml [triggers]): daily sponsorship reminder previews.
  async scheduled(event, env = {}, ctx = {}) {
    // The runtime keeps the invocation alive until this returned promise
    // settles. Errors are logged so a transient failure never fails the tick.
    try {
      await runScheduledSponsorshipReminders(getDb(env), { env, scheduledTime: event?.scheduledTime });
    } catch (err) {
      console.error('sponsorship reminder preview failed', err);
    }
  },
};
