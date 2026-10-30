# Hack the Valley Domain Model

Last updated: 2026-06-25

This document is the Milestone 0 domain-vocabulary baseline for the Hack the Valley community platform. It records the current truth before refactoring so later work can improve the implementation without drifting route behavior or production data.

## Baseline confirmation

Before this Milestone 0 update, the worktree was confirmed to be on `palmer/domain-milestone-0` at `a689f545a214997a85186a9600de1f128d41b4ad`, matching `origin/main` / `origin/HEAD`. The recent Demo Hours changes are present in that baseline, including:

- `a689f54` — Fix Demo Hours address and signed-in signup.
- `9f7a612` — Add Demo Hours poster header image.

No production data migration or route behavior change is part of this milestone.

## Product frame

Hack the Valley is not trying to become a generic CRM or Eventbrite clone. The core loop is:

1. Plan a concrete community gathering.
2. Publish the page and collect intent.
3. Know who is coming, who showed up, what they did, and what they need next.
4. Capture projects, demos, media, awards, and outcomes.
5. Send the right follow-up.
6. Use that history to make the next gathering better.

Everything in the model should support that loop.

## Domain vocabulary

| Domain concept | Meaning | Owns / key rules | Current representation |
| --- | --- | --- | --- |
| `Person` | A real human in the Hack the Valley community. | Identity, profile, safety/contact facts, authentication/session relationships, roles, attendance history, project membership, and badge awards. Email is an attribute, not the identity. | Mostly `users`, with related `user_sessions`, `auth_login_codes`, `roles`, `signups`, `project_members`, `user_badges`, and profile/admin routes. |
| `EventSeries` | A reusable program or public event concept such as Hack Hours, Demo Hours, or Hack the Valley 2026. | Stable slug, public URL namespace, default title/content/venue/capacity/signup configuration, recurrence metadata, and default lifecycle policy. It is not one concrete date when the program repeats. | `events`, admin event form, `/events`, `/events/:slug`, and `/api/events`. |
| `EventInstance` | One concrete occurrence of an `EventSeries`, such as a specific Hack Hours or Demo Hours date. | Date/time/location/capacity/status for one occurrence, roster scope, check-in scope, photos/media scope, and follow-up/cockpit scope. | `event_instances`, recurrence helper code, event instance admin/cockpit/follow-up/photos/project routes. |
| `Participation` | A `Person`'s relationship with one `EventInstance`. | Intent and state such as signed up, checked in, no-show, cancelled, waitlisted; participant role such as attendee, demo presenter, mentor, volunteer, or organizer; emergency/readiness linkage; attendance history. Signup is an input/action, not the concept. | `signups`, `event_participant_events`, `event_participant_current_state`, `emergency_contacts`, signup/check-in APIs. |
| `Project` | A durable thing a person or team is building. | Title, description, repo/demo/media links, team/members, public showcase identity, and canonical link to older submissions when needed. It can exist outside any single event. | `projects`, `project_members`, legacy/import source `submissions`, `/api/projects`, `/api/me/projects`, `/projects`. |
| `EventProjectSubmission` | A `Project`'s relationship with a specific event series or instance. | Submitted/demoed/showcased/hidden/winner state, judging/showcase visibility, and link back to a legacy submission when needed. This is not the project itself. | `event_project_submissions`, project review/showcase routes, event project routes. |
| `Badge` | A durable community achievement or progression signal. | Badge catalog metadata and explicit derivation/manual-award rules. Badges encode useful community state, not decoration. | `badges`, badge catalog migrations, user badge admin/profile APIs. |
| `BadgeAward` | The fact that a `Person` earned or was granted a `Badge`, optionally in an event/project context. | Awarded person, badge, source, awarded timestamp, optional event instance/project context, and who/what awarded it. Award facts must not be inferred from display labels alone. | `user_badges`; some award-style badge eligibility is derived from `event_project_awards`, `event_participant_events`, or `project_members`. |
| `PhysicalResource` | A tangible Hack the Valley-owned item such as a projector, laptop, badge printer, cable kit, or consumable bin. | Stable resource URL, mutable inventory labels/details, condition/status, location, admin photo, and checkout/return history. The `/resources/:id` URL contains the physical resource id; QR codes are just external labels that encode that URL. | `physical_resources`, `physical_resource_checkouts`, admin inventory UI/API, and `/resources/:id` stable URL route. |
| `ContentItem` | Editorial or public presentation content such as event pages, recap pages, static pages, blog-style posts, and announcements. | Public wording, page body, media references, publish state, and safe references to events/projects/people. Content may reference facts but must not become the source of truth for attendance, submissions, or awards. | `events.page_content`, static files under `public/`, public data JSON, event/project pages, and blog posts written in `/admin` (`blog_posts`, `functions/_lib/domain/blog-post.js`). |
| `Campaign` | A planned outbound communication effort, such as an event announcement, reminder, or follow-up. | Purpose, audience intent, draft/message association, approval state, and send plan. Sending remains human approval-gated. | Not first-class in D1 yet; represented by organizer workflow, Resend configuration, `/api/subscribe`, signup mailing-list sync, cockpit/follow-up helpers. |
| `AudienceSegment` | A computable audience definition for a `Campaign`. | Segment criteria derived from people, participation, project, badge, and opt-in facts. It should not duplicate core facts. | External Resend segment IDs/config plus derived filters from `users`, `signups`, `event_participant_events`, `project_members`, and `badges`. No dedicated segment table yet. |
| `MessageDraft` | The editable message content prepared for a `Campaign` before sending. | Subject/body/content variant, target campaign, reviewer/approval state, and safe previews. It is not a delivery log. | Admin email drafts (`functions/_lib/domain/message-draft.js`), created in Resend as draft broadcasts or sent from `/admin` once an admin types SEND to approve the audience and count; each send is audited (`message_draft.send`). Also follow-up/cockpit-generated copy and organizer-held drafts. Draft content is not stored in D1; only idempotency receipts are (`message_draft_receipts`). |
| `MessageDelivery` | A delivery attempt/result for a message to a person/address. | Recipient, provider response/status, timestamps, and failure detail. Delivery logs must not mutate underlying event facts. | `signups.mailing_list_status` / `mailing_list_detail`, Resend API responses, legacy MailChannels registration email path; no general delivery table yet. |
| `AuditEvent` | A durable record that an actor changed important platform state. | Actor, action, target, scope, metadata, and timestamp. Audit records are append-only operational facts. | `audit_events` for generic command audit going forward, with legacy `admin_audit_events` still read during rollout. |

## Storage compatibility table

This table maps the domain language above to the current tables, files, and routes. Milestone 0 freezes vocabulary only; migration status describes compatibility posture, not new implementation work.

| Domain concept | Current table(s) / files / routes | Migration status |
| --- | --- | --- |
| `Person` | `users`, `user_sessions`, `auth_login_codes`, `roles`, `helper_interests`, `project_members`, `user_badges`; `/api/me`, `/api/users`, `/api/auth/*`, `/api/admin/roles` | Represented in current schema; keep `users` storage name for now and introduce domain naming only through later helpers. |
| `EventSeries` | `events`; `public/events/index.html`, `public/admin.html`; `functions/api/events/index.js`, `functions/api/events/[slug].js` | Current source of truth for reusable event/program metadata; no table rename in Milestone 0. |
| `EventInstance` | `event_instances`; `functions/_lib/recurrence.js`; `functions/api/events/[slug]/instances/[instanceId]/*`; cockpit/follow-up/photos routes | Current source of truth for concrete occurrences; recurrence generation exists as guarded helper behavior, not an automatic production mutation. |
| `Participation` | `signups`, `event_participant_events`, `event_participant_current_state`, `emergency_contacts`; `/api/events/:slug/signups`, `/api/events/:slug/checkins`, `/api/register` | Current participation facts are split between durable signup rows and append-only events; preserve compatibility and route outputs. |
| `Project` | `projects`, `project_members`, `submissions`; `/api/projects`, `/api/me/projects`, `/projects`, `/submit` | Represented today with legacy submission bridge; keep public projections safe from private submission/contact payloads. |
| `EventProjectSubmission` | `event_project_submissions`; `/api/events/:slug/projects`, `/api/events/:slug/instances/:instanceId/projects`, `/api/events/:slug/projects/:projectId` | Represented today as project-event relationship; status language is compatible with showcase/review flows. |
| `Badge` | `badges`; `migrations/0015_community_badge_catalog.sql`; `/api/users/:id/badges`, profile/community state helpers | Catalog represented today; keep explicit rule metadata and avoid a generalized rules engine in Milestone 0. |
| `BadgeAward` | `user_badges`; derived award eligibility from `event_project_awards`, `event_participant_events`, and `project_members` | Manual/derived awards are compatible; future helper can make derivation explicit without changing current tables. |
| `PhysicalResource` | `physical_resources`, `physical_resource_checkouts`; `functions/_lib/domain/physical-resources.js`; `/api/admin/physical-resources`; `/resources/:id`; `public/admin.html` | Represented today as admin-only inventory with stable resource URLs. The physical-resource id is embedded in the URL; inventory codes and asset tags are mutable attributes. |
| `ContentItem` | `events.page_content`, `public/`, `public/data/*.json`, public event/project pages, `blog_posts` (migration 0032) | Partially represented through event/static content; blog posts written in admin are first-class in `blog_posts` (draft/published, audited publish). Other content has no dedicated storage yet. |
| `Campaign` | Resend configuration/env, `functions/_shared/mailing-list.js`, `/api/subscribe`, event follow-up/cockpit helpers | Not first-class in current storage; keep sends approval-gated and avoid adding campaign tables in Milestone 0. |
| `AudienceSegment` | Resend segment config plus filters over `users`, `signups`, `event_participant_events`, `project_members`, `badges` | External/derived today; do not duplicate facts into new segment storage in Milestone 0. |
| `MessageDraft` | Admin email drafts in `functions/_lib/domain/message-draft.js` (`/admin` Email section, created as Resend draft broadcasts or sent after a typed SEND), organizer-held drafts, generated copy from `functions/api/events/[slug]/instances/[instanceId]/followup/index.js`, and static/reference launch packets under `references/` | Partially represented: admin email content lives in Resend, not D1. `message_draft_receipts` (migration 0031) records one receipt per draft or send request for idempotency, not per-recipient deliveries, and each send is in `audit_events`. Other drafts remain review artifacts until later milestones. |
| `MessageDelivery` | `signups.mailing_list_status`, `signups.mailing_list_detail`, Resend contact/segment API results, legacy MailChannels path in `/api/register` | Partially represented for list sync only; no general delivery-log migration in Milestone 0. |
| `AuditEvent` | `audit_events` for generic command writes; compatibility reads union legacy `admin_audit_events`; `functions/api/admin/roles.js` now writes through the audit domain helper. | Milestone 11 adds the current compatible append-only table without production backfill; legacy rows remain queryable until an approved backfill/cutover. |

## Approval gates and no-production-mutation rule

- Milestone 0 is docs/tests only. It must not create `functions/_lib/domain/*`, change routes, deploy, run migrations, or mutate production data.
- Recurrence generation, public announcements, email sends, campaign launches, and message deliveries require human approval before they affect real users.
- `Campaign`, `MessageDraft`, and `MessageDelivery` work must preserve approval-gated sending. Drafting or previewing copy is not permission to send it.
- Delivery logs and campaign state must never rewrite the underlying event, participation, project, or badge facts.

## Current recurrence truth

`events.recurrence_rule_json` exists, and the current codebase includes guarded recurrence helpers plus tests for idempotent instance generation. Recurrence metadata should still be treated carefully:

- event creation/update can store `recurrence_rule_json`;
- signup/check-in paths resolve against existing open `event_instances`;
- if no open instance exists, public signup fails instead of silently creating production state;
- any production instance creation/open/close workflow must remain explicit and reviewable.

## Boundary rules

- If it answers “who is this human?” it belongs to `Person`.
- If it answers “what program/public event concept is this?” it belongs to `EventSeries`.
- If it answers “what concrete gathering/date is this?” it belongs to `EventInstance`.
- If it answers “what is this person's state at this instance?” it belongs to `Participation`.
- If it answers “what did this team build?” it belongs to `Project`.
- If it answers “where was this project shown/submitted?” it belongs to `EventProjectSubmission`.
- If it answers “what achievement exists?” it belongs to `Badge`.
- If it answers “who earned which badge, when, and why?” it belongs to `BadgeAward`.
- If it answers “what physical item does this `/resources/:id` URL point to?” it belongs to `PhysicalResource`.
- If it answers “what appears publicly?” it belongs to `ContentItem` or a safe public projection.
- If it answers “who should hear from us?” it belongs to `AudienceSegment`.
- If it answers “what communication are we planning?” it belongs to `Campaign`.
- If it answers “what are we preparing to say?” it belongs to `MessageDraft`.
- If it answers “what was sent and what happened?” it belongs to `MessageDelivery`.
- If it answers “who changed important state?” it belongs to `AuditEvent`.

## Refactor posture

Do not big-bang rename the database. The safer sequence is:

1. Freeze vocabulary in docs and tests.
2. Add domain helper modules that expose the right concepts while preserving existing tables.
3. Move routes to helpers one slice at a time.
4. Add migrations only when a concept cannot be safely represented with current tables.
5. Keep public routes/API compatibility unless intentionally changed.

## Sponsorship management

Sponsorship management is a separate organizer domain, accessible only to active
signed-in global admins. It uses the existing `Person` identities for ownership:
one user owns many sponsorship motions; each motion has one assigned owner.

| Concept | Storage | Boundary |
| --- | --- | --- |
| SponsorContact | `sponsor_contacts` | A reusable business and its one primary contact; no participant login is created. |
| SponsorshipCampaign | `sponsorship_campaigns` | A named annual/event fundraising effort, optionally linked to an event instance; distinct from an outbound communication Campaign. |
| SponsorshipMotion | `sponsorship_motions` | One contact/campaign pair, its owner, outreach state, notes, and current follow-up. |
| Sponsorship | `sponsorships` | Zero or one commitment per motion; cash/in-kind amounts, payment references, fulfillment, and private logo metadata. |
| SponsorshipActivity | `sponsorship_activities` | Completed outreach actions and change history scoped to a motion. |
| ReminderDigest | `sponsorship_reminder_digests` | A preview-only overdue summary, unique per owner/Pacific date/mode; not a claim of email delivery. |

All new tables are defined by migration `0030_sponsorship_management.sql`. Mutations record a retry receipt
in the same D1 transaction as their data, activity, and audit changes. Optimistic
revision guards reject stale writes. Daily summaries include only overdue,
unfinished follow-ups in active campaigns, excluding Lost/Paid motions and
inactive admin owners. Local setup, accounts, and demo steps are in
[`sponsorship-prototype.md`](sponsorship-prototype.md).
