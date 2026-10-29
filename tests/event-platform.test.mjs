import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  addSignupToEmailList,
  applySignupRole,
  checkInAttendee,
  createHelperInterest,
  csvEscape,
  getEventSeries,
  getParticipationCockpitReadModel,
  listEvents,
  listEventSeries,
  listHelperInterests,
  normalizeEventInput,
  normalizeHelperInterestInput,
  normalizeParticipationInput,
  normalizeSignupInput,
  registerParticipation,
  requireAdmin,
  requireSuperAdminAccess,
  renderEventPageHtml,
  resolveSignupEventInstance,
  searchCheckinCandidates,
  signupsToCsv,
  slugify,
  upsertEvent,
  upsertUser
} from "../functions/_lib/event-platform.js";
import {
  ensureEventInstances,
  generateEventInstanceCandidates,
  validateRecurrenceRule
} from "../functions/_lib/recurrence.js";
import worker from "../worker.js";
import { onRequestPost as postEventSignup } from "../functions/api/events/[slug]/signups/index.js";
import { onRequestPost as postEventCheckin } from "../functions/api/events/[slug]/checkins/index.js";
import { onRequestGet as getEventPhotos } from "../functions/api/events/[slug]/instances/[instanceId]/photos/index.js";

function roleAwareAdminDb({ role = "admin", users = [] } = {}) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          this.args = args;
          return this;
        },
        async first() {
          if (/FROM user_sessions/.test(sql)) {
            return {
              id: "usr_admin",
              email: "admin@example.com",
              name: "Admin User",
              session_id: "ses_admin",
              session_expires_at: "2099-01-01T00:00:00.000Z"
            };
          }
          if (/FROM roles/.test(sql)) {
            return role && this.args.includes(role) ? { role, scope_type: "global", scope_id: "*", created_at: "2026-01-01T00:00:00.000Z" } : null;
          }
          throw new Error(`Unexpected first() query: ${sql}`);
        },
        async all() {
          if (/FROM users/.test(sql)) return { results: users };
          return { results: [] };
        }
      };
    }
  };
}

function participationRouteDb({ currentUser = null, role = "admin" } = {}) {
  const event = {
    slug: "demo-hours",
    title: "Demo Hours",
    status: "open",
    signup_fields_json: JSON.stringify({
      role_label: "I want to",
      default_role: "attend",
      roles: [{ value: "attend", label: "Attend" }, { value: "demo", label: "Demo something" }]
    })
  };
  const instances = [
    { id: "inst_demo_current", event_slug: "demo-hours", instance_key: "current", starts_at: "2026-07-22T01:00:00.000Z", status: "open" },
    { id: "inst_demo_selected", event_slug: "demo-hours", instance_key: "selected", starts_at: "2026-07-29T01:00:00.000Z", status: "closed" }
  ];
  const usersById = new Map([
    ["usr_admin", { id: "usr_admin", email: "admin@example.com", name: "Admin User", metadata_json: null }],
    ["usr_existing", { id: "usr_existing", email: "selected@example.com", name: "Selected User", first_name: "Selected", last_name: "User", phone: "661-555-0100", metadata_json: null }]
  ]);
  const usersByEmail = new Map([...usersById.values()].map((user) => [user.email, user]));
  if (currentUser) {
    usersById.set(currentUser.id, currentUser);
    usersByEmail.set(currentUser.email, currentUser);
  }
  const signups = [];
  const emergencyContacts = [];
  const participantEvents = [];
  let userSeq = 0;

  function stateFor(eventInstanceId, userId) {
    const rows = participantEvents.filter((row) => row.event_instance_id === eventInstanceId && row.user_id === userId);
    return {
      signed_up_at: rows.find((row) => row.event_type === "signed_up")?.occurred_at || null,
      checked_in_at: rows.find((row) => row.event_type === "checked_in")?.occurred_at || null,
      checked_out_at: null,
      cancelled_at: null
    };
  }

  function signupRow(signup) {
    const user = usersById.get(signup.user_id) || {};
    const state = stateFor(signup.event_instance_id, signup.user_id);
    return {
      ...signup,
      ...state,
      email: user.email,
      name: signup.name || user.name,
      first_name: signup.first_name || user.first_name,
      last_name: signup.last_name || user.last_name,
      phone: signup.phone || user.phone,
      school: signup.school || user.school,
      signup_role: JSON.parse(signup.metadata_json || "{}").signup_role || null
    };
  }

  const db = {
    event,
    instances,
    usersById,
    usersByEmail,
    signups,
    emergencyContacts,
    participantEvents,
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() {
          if (/FROM user_sessions/.test(sql)) {
            return currentUser ? { ...currentUser, session_id: "ses_test", session_expires_at: "2099-01-01T00:00:00.000Z" } : null;
          }
          if (/FROM roles/.test(sql)) {
            return role && this.args.includes(role) ? { role, scope_type: "global", scope_id: "*", created_at: "2026-01-01T00:00:00.000Z" } : null;
          }
          if (/FROM events\s+WHERE slug = \?/.test(sql)) return this.args[0] === event.slug ? event : null;
          if (/FROM event_instances\s+WHERE event_slug = \? AND status = 'open'/.test(sql)) return instances.find((row) => row.event_slug === this.args[0] && row.status === "open") || null;
          if (/SELECT \* FROM event_instances WHERE event_slug = \? AND id = \?/.test(sql)) return instances.find((row) => row.event_slug === this.args[0] && row.id === this.args[1]) || null;
          if (/SELECT \* FROM users WHERE id = \?/.test(sql)) return usersById.get(this.args[0]) || null;
          if (/SELECT \* FROM users WHERE email = \?/.test(sql)) return usersByEmail.get(this.args[0]) || null;
          if (/SELECT \* FROM users WHERE lower\(email\) = \?/.test(sql)) return usersByEmail.get(this.args[0]) || null;
          if (/FROM emergency_contacts/.test(sql)) return emergencyContacts.find((row) => row.event_instance_id === this.args[0] && row.user_id === this.args[1]) || null;
          if (/FROM signups s\s+JOIN users u/.test(sql)) {
            const eventInstanceId = this.args.length === 3 ? this.args[1] : this.args[0];
            const userId = this.args.at(-1);
            const signup = signups.find((row) => row.event_instance_id === eventInstanceId && row.user_id === userId);
            return signup ? signupRow(signup) : null;
          }
          throw new Error(`Unexpected first() query: ${sql}`);
        },
        async all() {
          if (/FROM users u\s+LEFT JOIN signups s/.test(sql)) return { results: [] };
          if (/FROM signups s\s+JOIN users u/.test(sql)) return { results: signups.map(signupRow) };
          if (/FROM roles/.test(sql)) return { results: [] };
          return { results: [] };
        },
        async run() {
          if (/INSERT INTO users/.test(sql)) {
            const [requestedId, email, name, firstName, lastName, phone, school, metadataJson, createdAt, updatedAt] = this.args;
            const user = usersByEmail.get(email) || { id: requestedId || `usr_${++userSeq}`, email, created_at: createdAt };
            Object.assign(user, { name: name || user.name || null, first_name: firstName || user.first_name || null, last_name: lastName || user.last_name || null, phone: phone || user.phone || null, school: school || user.school || null, metadata_json: metadataJson || user.metadata_json || null, updated_at: updatedAt });
            usersByEmail.set(email, user);
            usersById.set(user.id, user);
            return { success: true };
          }
          if (/UPDATE users\s+SET metadata_json = \?/.test(sql)) {
            const [metadataJson, updatedAt, userId] = this.args;
            const user = usersById.get(userId);
            if (user) Object.assign(user, { metadata_json: metadataJson, updated_at: updatedAt });
            return { success: true };
          }
          if (/INSERT INTO signups/.test(sql)) {
            const [id, eventSlug, eventInstanceId, userId, name, firstName, lastName, phone, school, year, experience, notes, emailListOptIn, metadataJson, mailingStatus, mailingDetail, createdAt, updatedAt] = this.args;
            let signup = signups.find((row) => row.event_instance_id === eventInstanceId && row.user_id === userId);
            if (!signup) {
              signup = { id, event_slug: eventSlug, event_instance_id: eventInstanceId, user_id: userId, created_at: createdAt };
              signups.push(signup);
            }
            Object.assign(signup, { name, first_name: firstName, last_name: lastName, phone, school, year, experience, notes, email_list_opt_in: emailListOptIn, metadata_json: metadataJson, mailing_list_status: mailingStatus, mailing_list_detail: mailingDetail, updated_at: updatedAt });
            return { success: true };
          }
          if (/INSERT INTO emergency_contacts/.test(sql)) {
            const [id, eventInstanceId, userId, signupId, name, relationship, phone, source, createdAt, updatedAt] = this.args;
            emergencyContacts.push({ id, event_instance_id: eventInstanceId, user_id: userId, signup_id: signupId, name, relationship, phone, source, created_at: createdAt, updated_at: updatedAt });
            return { success: true };
          }
          if (/INSERT OR IGNORE INTO event_participant_events/.test(sql)) {
            const [id, eventSlug, eventInstanceId, userId, signupId, eventType, actor, source, dataJson, occurredAt, createdAt] = this.args;
            if (!participantEvents.some((row) => row.id === id)) participantEvents.push({ id, event_slug: eventSlug, event_instance_id: eventInstanceId, user_id: userId, signup_id: signupId, event_type: eventType, actor, source, data_json: dataJson, occurred_at: occurredAt, created_at: createdAt });
            return { success: true };
          }
          throw new Error(`Unexpected run() query: ${sql}`);
        }
      };
    }
  };
  return db;
}

test("slugify creates stable event slugs", () => {
  assert.equal(slugify("Hack Hours at Panera!"), "hack-hours-at-panera");
  assert.equal(slugify("  AI & Career Night  "), "ai-and-career-night");
});

test("event input validates required fields and statuses", () => {
  const ok = normalizeEventInput({
    title: "Hack Hours at Panera",
    status: "open",
    capacity: "30"
  });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.event.slug, "hack-hours-at-panera");
  assert.equal(ok.event.capacity, 30);

  const bad = normalizeEventInput({ title: "", slug: "Bad Slug", status: "published" });
  assert.match(bad.errors.join(";"), /title is required/);
  assert.match(bad.errors.join(";"), /slug/);
  assert.match(bad.errors.join(";"), /status/);
});

test("event input supports optional capacity, photos, editable page content, and recurrence metadata", () => {
  const { event, errors } = normalizeEventInput({
    title: "Hack the Valley 2026",
    status: "closed",
    capacity: "",
    image_url: "/images/events/2026/hero.jpg",
    page_content: "Agenda, parking, eligibility, and recap links live here.",
    signup_fields: { role_label: "I want to", default_role: "attend", roles: [{ value: "attend", label: "Attend" }, { value: "demo", label: "Demo something" }] },
    recurrence_rule: { frequency: "yearly", interval: 1 }
  });

  assert.deepEqual(errors, []);
  assert.equal(event.slug, "hack-the-valley-2026");
  assert.equal(event.capacity, null);
  assert.equal(event.image_url, "/images/events/2026/hero.jpg");
  assert.equal(event.page_content, "Agenda, parking, eligibility, and recap links live here.");
  assert.match(event.signup_fields_json, /"default_role":"attend"/);
  assert.equal(event.recurrence_rule_json, JSON.stringify({ frequency: "yearly", interval: 1 }));
});

test("weekly recurrence rules generate stable upcoming event instance candidates", () => {
  const { errors } = validateRecurrenceRule({
    frequency: "weekly",
    interval: 1,
    timezone: "America/Los_Angeles",
    day_of_week: "saturday",
    start_time: "08:00",
    duration_minutes: 120,
    starts_on: "2026-06-27",
    generate_weeks_ahead: 2
  });
  assert.deepEqual(errors, []);

  const candidates = generateEventInstanceCandidates({
    slug: "hack-hours",
    title: "Hack Hours",
    venue_name: "Panera Bread",
    venue_address: "10900 Stockdale Hwy, Bakersfield, CA 93311",
    capacity: 24,
    recurrence_rule_json: JSON.stringify({
      frequency: "weekly",
      interval: 1,
      timezone: "America/Los_Angeles",
      day_of_week: "saturday",
      start_time: "08:00",
      duration_minutes: 120,
      starts_on: "2026-06-27",
      generate_weeks_ahead: 2
    })
  }, { now: "2026-06-22T12:00:00.000Z" });

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].id, "inst_hack_hours_2026_06_27_0800");
  assert.equal(candidates[0].instance_key, "2026-06-27-0800");
  assert.equal(candidates[0].starts_at, "2026-06-27T15:00:00.000Z");
  assert.equal(candidates[0].ends_at, "2026-06-27T17:00:00.000Z");
  assert.equal(candidates[0].status, "draft");
  assert.equal(candidates[0].venue_name, "Panera Bread");
});

test("recurring event instance generation is idempotent and insert-missing only", async () => {
  const rows = [{ instance_key: "2026-06-27-0800", id: "existing" }];
  const inserted = [];
  const db = {
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async all() {
          assert.match(sql, /FROM event_instances/);
          return { results: rows };
        },
        async run() {
          assert.match(sql, /INSERT INTO event_instances/);
          inserted.push(this.args);
          rows.push({ id: this.args[0], instance_key: this.args[2] });
          return { success: true };
        }
      };
    }
  };
  const event = {
    slug: "hack-hours",
    title: "Hack Hours",
    recurrence_rule_json: JSON.stringify({
      frequency: "weekly",
      interval: 1,
      timezone: "America/Los_Angeles",
      day_of_week: "saturday",
      start_time: "08:00",
      duration_minutes: 120,
      starts_on: "2026-06-27",
      generate_weeks_ahead: 2
    })
  };

  const first = await ensureEventInstances(db, event, { now: "2026-06-22T12:00:00.000Z" });
  assert.equal(first.existing.length, 1);
  assert.equal(first.created.length, 1);
  assert.equal(inserted[0][2], "2026-07-04-0800");

  const second = await ensureEventInstances(db, event, { now: "2026-06-22T12:00:00.000Z" });
  assert.equal(second.created.length, 0);
  assert.equal(inserted.length, 1);
});

test("upsertEvent persists event page fields", async () => {
  const prepared = [];
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) {
          this.args = args;
          prepared.push(this);
          return this;
        },
        async run() {
          return { success: true };
        },
        async first() {
          return {
            slug: this.args[0],
            title: "Hack the Valley 2026",
            image_url: "/images/events/2026/hero.jpg",
            page_content: "Editable event page body",
            recurrence_rule_json: JSON.stringify({ frequency: "yearly" })
          };
        }
      };
      return statement;
    }
  };

  await upsertEvent(db, {
    title: "Hack the Valley 2026",
    image_url: "/images/events/2026/hero.jpg",
    page_content: "Editable event page body",
    recurrence_rule: { frequency: "yearly" }
  });

  assert.match(prepared[0].sql, /image_url/);
  assert.match(prepared[0].sql, /page_content/);
  assert.doesNotMatch(prepared[0].sql, /content_before/);
  assert.doesNotMatch(prepared[0].sql, /content_after/);
  assert.match(prepared[0].sql, /recurrence_rule_json/);
  assert.ok(prepared[0].args.includes("/images/events/2026/hero.jpg"));
  assert.ok(prepared[0].args.includes("Editable event page body"));
  assert.ok(prepared[0].args.includes(JSON.stringify({ frequency: "yearly" })));
});

test("upsertEvent rejects invalid JSON configs before DB writes", async () => {
  const prepared = [];
  const writes = [];
  const db = {
    prepare(sql) {
      prepared.push(sql);
      return {
        bind(...args) {
          this.args = args;
          return this;
        },
        async run() {
          writes.push({ sql, args: this.args });
          return { success: true };
        },
        async first() {
          return null;
        }
      };
    }
  };

  await assert.rejects(
    () => upsertEvent(db, { title: "Broken", signup_fields_json: "[]" }),
    /signup_fields_json must be a JSON object/
  );
  await assert.rejects(
    () => upsertEvent(db, { title: "Broken", recurrence_rule_json: JSON.stringify({ interval: 0 }) }),
    /recurrence_rule_json\.interval/
  );

  assert.equal(prepared.length, 0);
  assert.equal(writes.length, 0);
});

test("upsertUser gives users their own ID space and never uses email as ID", async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) {
          this.args = args;
          statements.push(this);
          return this;
        },
        async run() {
          return { success: true };
        },
        async first() {
          return {
            id: this.args[0]?.startsWith?.("usr_") ? this.args[0] : "usr_existing",
            email: "ada@example.com",
            name: "Ada Lovelace"
          };
        }
      };
      return statement;
    }
  };

  const user = await upsertUser(db, {
    email: " ADA@example.COM ",
    name: "Ada Lovelace",
    first_name: "Ada",
    last_name: "Lovelace"
  });

  assert.match(user.id, /^usr_/);
  assert.notEqual(user.id, "ada@example.com");
  assert.match(statements[0].sql, /INSERT INTO users/);
  assert.match(statements[0].sql, /ON CONFLICT\(email\)/);
});

test("signup input normalizes email and legacy school field", () => {
  const { signup, errors } = normalizeSignupInput({
    name: "Ada Lovelace",
    email: " ADA@example.COM ",
    university: "CSUB",
    emergency_contact_name: "Charles Babbage",
    emergency_contact_phone: "661-555-0100",
    email_list_opt_in: true
  }, "hack-hours-panera");

  assert.deepEqual(errors, []);
  assert.equal(signup.email, "ada@example.com");
  assert.equal(signup.first_name, "Ada");
  assert.equal(signup.last_name, "Lovelace");
  assert.equal(signup.school, "CSUB");
  assert.equal(signup.email_list_opt_in, 1);
});

test("signed-in signup input can use session profile instead of contact fields", () => {
  const { signup, errors } = normalizeSignupInput({
    signup_role: "demo",
    email: "",
    phone: ""
  }, "demo-hours", {
    requireEmergencyContact: false,
    currentUser: {
      id: "usr_ada",
      name: "Ada Lovelace",
      email: " ADA@example.COM ",
      phone: "661-555-0100",
      school: "CSUB"
    }
  });

  assert.deepEqual(errors, []);
  assert.equal(signup.name, "Ada Lovelace");
  assert.equal(signup.email, "ada@example.com");
  assert.equal(signup.phone, "661-555-0100");
  assert.equal(signup.school, "CSUB");
  assert.match(signup.metadata_json, /"signup_role":"demo"/);
});

test("signup roles are configurable and stored in signup metadata", () => {
  const event = {
    slug: "demo-hours",
    signup_fields_json: JSON.stringify({
      role_label: "I want to",
      default_role: "attend",
      roles: [
        { value: "attend", label: "Attend" },
        { value: "demo", label: "Demo something" }
      ]
    })
  };

  const accepted = applySignupRole({ signup_role: "Demo" }, event);
  assert.deepEqual(accepted.errors, []);
  assert.equal(accepted.input.signup_role, "demo");

  const defaulted = applySignupRole({}, event);
  assert.equal(defaulted.input.signup_role, "attend");

  const rejected = applySignupRole({ signup_role: "judge" }, event);
  assert.match(rejected.errors.join(";"), /signup role must be one of/);

  const { signup, errors } = normalizeSignupInput({
    name: "Ada Lovelace",
    email: "ada@example.com",
    signup_role: "demo",
    emergency_contact_name: "Charles Babbage",
    emergency_contact_phone: "661-555-0100"
  }, "demo-hours");
  assert.deepEqual(errors, []);
  assert.match(signup.metadata_json, /"signup_role":"demo"/);
});

test("signup input requires name and valid email", () => {
  const { errors } = normalizeSignupInput({ name: "", email: "bad" }, "hack-hours-panera");
  assert.match(errors.join(";"), /name is required/);
  assert.match(errors.join(";"), /valid email is required/);
});

test("helper interest input captures volunteer leads without treating them as participants", () => {
  const { helperInterest, errors } = normalizeHelperInterestInput({
    role_interest: "Workshop Host",
    availability: "Weeknights",
    skills: "AI mentoring and sponsor intros",
    consent_contact: "yes"
  }, {
    id: "usr_helper",
    email: "HELPER@Example.COM",
    name: "Helper Person"
  });

  assert.deepEqual(errors, []);
  assert.equal(helperInterest.user_id, "usr_helper");
  assert.equal(helperInterest.name, "Helper Person");
  assert.equal(helperInterest.email, "helper@example.com");
  assert.equal(helperInterest.role_interest, "workshop_host");
  assert.equal(helperInterest.status, "new");
});

test("helper interest input requires contact, allowed role, and consent", () => {
  const { errors } = normalizeHelperInterestInput({ name: "No Consent", role_interest: "speaker" });
  assert.match(errors.join(";"), /email or contact method is required/);
  assert.match(errors.join(";"), /role interest must be/);
  assert.match(errors.join(";"), /consent to be contacted is required/);
});

test("helper interest records persist privately and list only through the admin helper", async () => {
  const rows = [];
  const db = {
    prepare(sql) {
      return {
        sql,
        args: [],
        bind(...args) { this.args = args; return this; },
        async run() {
          assert.match(sql, /INSERT INTO helper_interests/);
          const [id, created_at, updated_at, user_id, name, email, contact, role_interest, availability, event_interest, skills, notes, consent_contact, source, status, metadata_json] = this.args;
          rows.push({ id, created_at, updated_at, user_id, name, email, contact, role_interest, availability, event_interest, skills, notes, consent_contact, source, status, metadata_json });
          return { success: true };
        },
        async first() {
          assert.match(sql, /SELECT \* FROM helper_interests WHERE id = \?/);
          return rows.find((row) => row.id === this.args[0]);
        },
        async all() {
          assert.match(sql, /FROM helper_interests hi/);
          return { results: rows.map((row) => ({ ...row, account_email: null, account_name: null })) };
        }
      };
    }
  };

  const saved = await createHelperInterest(db, {
    id: "hlp_test",
    name: "Ada Helper",
    email: "ada@example.com",
    role_interest: "mentor",
    skills: "Web and AI",
    notes: "Can judge finals",
    consent_contact: true,
    metadata: { source_detail: "test" }
  });
  assert.equal(saved.id, "hlp_test");
  assert.equal(saved.email, "ada@example.com");

  const [listed] = await listHelperInterests(db);
  assert.equal(listed.email, "ada@example.com");
  assert.equal(listed.consent_contact, true);
  assert.deepEqual(listed.metadata, { source_detail: "test" });
});

test("worker exposes helper interest POST publicly but keeps the list admin-only", async () => {
  const rows = [];
  const db = {
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async run() {
          if (/INSERT INTO helper_interests/.test(sql)) {
            const [id, created_at, updated_at, user_id, name, email, contact, role_interest, availability, event_interest, skills, notes, consent_contact, source, status, metadata_json] = this.args;
            rows.push({ id, created_at, updated_at, user_id, name, email, contact, role_interest, availability, event_interest, skills, notes, consent_contact, source, status, metadata_json });
            return { success: true };
          }
          throw new Error(`Unexpected run() query: ${sql}`);
        },
        async first() {
          if (/SELECT \* FROM helper_interests WHERE id = \?/.test(sql)) return rows.find((row) => row.id === this.args[0]);
          if (/FROM user_sessions/.test(sql)) {
            return {
              id: "usr_admin",
              email: "admin@example.com",
              name: "Admin User",
              session_id: "ses_admin",
              session_expires_at: "2099-01-01T00:00:00.000Z"
            };
          }
          if (/FROM roles/.test(sql)) return { role: "admin", scope_type: "global", scope_id: "*", created_at: "2026-01-01T00:00:00.000Z" };
          throw new Error(`Unexpected first() query: ${sql}`);
        },
        async all() {
          if (/FROM helper_interests hi/.test(sql)) return { results: rows.map((row) => ({ ...row, account_email: null, account_name: null })) };
          return { results: [] };
        }
      };
    }
  };

  const postResponse = await worker.fetch(new Request("https://hackthevalley.org/api/helper-interest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Ada Helper", email: "ada@example.com", role_interest: "mentor", consent_contact: true })
  }), { HTV_DB: db }, {});
  assert.equal(postResponse.status, 201);
  const publicBody = await postResponse.json();
  assert.equal(publicBody.success, true);
  assert.equal(publicBody.helper_interest.role_interest, "mentor");
  assert.equal(publicBody.helper_interest.email, undefined);
  assert.equal(publicBody.helper_interest.contact, undefined);
  assert.equal(publicBody.helper_interest.name, undefined);

  const unauthorizedList = await worker.fetch(new Request("https://hackthevalley.org/api/helper-interest"), { HTV_DB: db }, {});
  assert.equal(unauthorizedList.status, 401);

  const adminList = await worker.fetch(new Request("https://hackthevalley.org/api/helper-interest", { headers: { cookie: "htv_session=test-session" } }), { HTV_DB: db }, {});
  assert.equal(adminList.status, 200);
  const adminBody = await adminList.json();
  assert.equal(adminBody.helper_interests[0].email, "ada@example.com");
});

test("Resend sync creates/updates a contact; per-event signup state stays in the app D1 database", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true }), { status: 201, headers: { "Content-Type": "application/json" } });
  };
  try {
    const result = await addSignupToEmailList(
      { RESEND_API_KEY: "re_test" },
      { email: "ada@example.com", first_name: "Ada", last_name: "Lovelace", email_list_opt_in: 1 },
      { slug: "hack-hours-panera", title: "Hack Hours at Panera" }
    );
    assert.equal(result.status, "synced");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.resend.com/contacts");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.email, "ada@example.com");
    assert.equal(body.properties, undefined);
    assert.equal(body.unsubscribed, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Resend sync patches existing contacts without forcing resubscribe", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return new Response("duplicate", { status: 409 });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const result = await addSignupToEmailList(
      { RESEND_API_KEY: "re_test" },
      { email: "ada@example.com", first_name: "Ada", last_name: "Lovelace", email_list_opt_in: 1 },
      { slug: "hack-hours-panera", title: "Hack Hours at Panera" }
    );
    assert.equal(result.status, "synced");
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, "https://api.resend.com/contacts/ada%40example.com");
    assert.equal(calls[1].init.method, "PATCH");
    assert.equal(Object.hasOwn(JSON.parse(calls[1].init.body), "unsubscribed"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Resend sync can skip cleanly when not configured or opted out", async () => {
  assert.deepEqual(
    await addSignupToEmailList({}, { email: "a@example.com", email_list_opt_in: 1 }, { slug: "e", title: "Event" }),
    { status: "skipped_not_configured", detail: "RESEND_API_KEY is not configured" }
  );
  assert.deepEqual(
    await addSignupToEmailList({ RESEND_API_KEY: "re_test" }, { email: "a@example.com", email_list_opt_in: 0 }, { slug: "e", title: "Event" }),
    { status: "skipped_opt_out", detail: "Registrant opted out of community email list" }
  );
});

test("CSV export includes metadata for event-specific hackathon fields", () => {
  assert.equal(csvEscape('Ada "Countess"'), '"Ada ""Countess"""');
  const csv = signupsToCsv([{
    event_slug: "hack-the-valley-2026",
    name: "Ada",
    email: "ada@example.com",
    notes: "line\nbreak",
    signup_role: "demo",
    metadata_json: JSON.stringify({ major: "CS", dietary: "vegetarian", tshirt: "M", coc: true })
  }]);
  assert.match(csv, /metadata_json/);
  assert.match(csv, /signup_role/);
  assert.match(csv, /demo/);
  assert.match(csv, /"line\nbreak"/);
  assert.match(csv, /"{""major"":""CS"",""dietary"":""vegetarian"",""tshirt"":""M"",""coc"":true}"/);
});

test("admin page is the canonical one-stop admin surface at /admin", () => {
  const html = readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  assert.match(html, /<title>Hack the Valley Admin<\/title>/);
  assert.match(html, /Create \/ update event/);
  assert.match(html, /Project submissions/);
  assert.match(html, /href="\/admin-submissions"/);
  assert.doesNotMatch(html, /admin-events\.html/);
});

test("admin page gates the full UI behind a signed-in admin role", () => {
  const html = readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  assert.match(html, /id="login-panel"/);
  assert.match(html, /id="admin-app"[\s\S]*hidden/);
  assert.match(html, /\/login\/\?next=\/admin/);
  assert.match(html, /api\("\/api\/admin\/me"\)/);
  assert.match(html, /active admin role/);
  assert.match(html, /id="role-admin"/);
  assert.match(html, /\/api\/admin\/roles/);
  assert.match(html, /Admin role grants/);
  assert.doesNotMatch(html, /localStorage\.setItem\("htv_admin_token"/);
  assert.doesNotMatch(html, /id="admin-token"/);
  assert.doesNotMatch(html, /Prefill Hack Hours at Panera/);
});

test("admin role helpers require session roles and keep token bootstrap opt-in only", async () => {
  const sessionRequest = new Request("https://hackthevalley.org/api/users", { headers: { cookie: "htv_session=test-session" } });
  const admin = await requireAdmin(sessionRequest, { HTV_DB: roleAwareAdminDb({ role: "admin" }) });
  assert.equal(admin.role.role, "admin");

  await assert.rejects(
    () => requireSuperAdminAccess(sessionRequest, { HTV_DB: roleAwareAdminDb({ role: "admin" }) }),
    /Forbidden/
  );
  const superAdmin = await requireSuperAdminAccess(sessionRequest, { HTV_DB: roleAwareAdminDb({ role: "super_admin" }) });
  assert.equal(superAdmin.role.role, "super_admin");

  const tokenRequest = new Request("https://hackthevalley.org/api/users", { headers: { Authorization: "Bearer legacy-secret" } });
  await assert.rejects(
    () => requireAdmin(tokenRequest, { HTV_DB: roleAwareAdminDb({ role: null }), HTV_ADMIN_TOKEN: "legacy-secret" }),
    /Unauthorized/
  );
  const bootstrap = await requireAdmin(tokenRequest, {
    HTV_DB: roleAwareAdminDb({ role: null }),
    HTV_ADMIN_TOKEN: "legacy-secret",
    HTV_ADMIN_BOOTSTRAP_TOKEN_ENABLED: "1"
  });
  assert.equal(bootstrap.bootstrap, true);
});

test("admin page lists event instances as flat rows without dropdowns", () => {
  const html = readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  assert.match(html, /id="users-admin"/);
  assert.match(html, /id="users-list"/);
  assert.match(html, /function loadUsers/);
  assert.match(html, /\/api\/users/);
  assert.match(html, /id="event-signups"/);
  assert.match(html, /function loadEventSignups\(slug, title = slug, instanceId = null/);
  assert.match(html, /params\.set\("instance_id", instanceId\)/);
  assert.match(html, /\/api\/events\/\$\{encodeURIComponent\(slug\)\}\/signups\$\{query\}/);
  assert.match(html, /function eventInstanceRows\(events\)/);
  assert.match(html, /data-signups-row=/);
  assert.match(html, /View signups/);
  assert.match(html, /Export CSV/);
  assert.doesNotMatch(html, /data-instance-select=/);
  assert.doesNotMatch(html, /selectedInstanceFor\(event\)/);
  assert.doesNotMatch(html, /<th[^>]*>School<\/th>/);
  assert.doesNotMatch(html, /<th[^>]*>Notes<\/th>/);
  assert.doesNotMatch(html, /user\.school/);
  assert.doesNotMatch(html, /signup\.school/);
  assert.doesNotMatch(html, /signup\.notes/);
});

test("admin page has one draft-only email composer that can start from a blog post", () => {
  const html = readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  const composer = readFileSync(new URL("../public/admin-message-draft.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="blog-blast"|Blog email draft|blogBlastPayload|Past sends/);
  assert.match(html, /id="message-draft-start"/);
  assert.match(html, /Create Resend draft/);
  assert.match(composer, /\/api\/admin\/message-drafts\/blog-post\?slug=/);
  assert.match(composer, /Nothing will be sent or scheduled from HTV admin/);
  for (const source of [html, composer]) {
    assert.doesNotMatch(source, /createDraft: true/);
    assert.doesNotMatch(source, /Schedule send/);
    assert.doesNotMatch(source, /Send now/);
    assert.doesNotMatch(source, /sendBlogBlast/);
  }
});

test("public event signup form skips profile fields for signed-in users and keeps anonymous form fields", () => {
  const html = readFileSync(new URL("../public/events/index.html", import.meta.url), "utf8");
  assert.match(html, /name="name"/);
  assert.match(html, /name="email" type="email" required/);
  assert.match(html, /name="emergency_contact_name"/);
  assert.match(html, /name="emergency_contact_phone"/);
  assert.match(html, /id="signup-profile-completion"/);
  assert.match(html, /data-profile-signup-field/);
  assert.match(html, /data-email-list-field/);
  assert.match(html, /fetch\("\/api\/me"/);
  assert.match(html, /state\.currentUser/);
  assert.match(html, /data\.person_safety_readiness \|\| data\.user\?\.safety_readiness/);
  assert.match(html, /signedInNeedsSafetyUpdate/);
  assert.match(html, /field\.hidden = signedIn/);
  assert.match(html, /field\.classList\.toggle\("hidden", signedIn\)/);
  assert.match(html, /input\.disabled = true/);
  assert.match(html, /signup-role-field/);
  assert.match(html, /payload\.signed_in_signup = true/);
  assert.match(html, /data\.profile_completion\?\.required/);
  assert.match(html, /update your emergency contact/);
  assert.match(html, /data\.code === "existing_account"/);
  assert.match(html, /data-existing-account-login/);
  assert.match(html, /Sign in with a magic link/);
  assert.doesNotMatch(html, /name="name" required/);
  assert.doesNotMatch(html, /name="emergency_contact_name" required/);
  assert.doesNotMatch(html, /name="emergency_contact_phone" required/);
  assert.doesNotMatch(html, /School \/ organization/);
  assert.doesNotMatch(html, /name="school"/);
  assert.doesNotMatch(html, /name="notes"/);
  assert.doesNotMatch(html, /Anything we should know/);
});

test("rendered event detail page shows venue name and address and supports signed-in signup mode", () => {
  const html = renderEventPageHtml({
    slug: "demo-hours",
    title: "Demo Hours",
    description: "Community demo night",
    starts_at: "2026-07-23T01:00:00.000Z",
    venue_name: "Mesh Cowork",
    venue_address: "2020 Eye street",
    status: "open",
    signup_fields_json: JSON.stringify({ role_label: "I want to", default_role: "attend", roles: [{ value: "attend", label: "Attend" }, { value: "demo", label: "Demo something" }] })
  });
  assert.match(html, /Mesh Cowork • 2020 Eye street/);
  assert.match(html, /data-profile-signup-field/);
  assert.match(html, /data-email-list-field/);
  assert.match(html, /id="signup-profile-completion"/);
  assert.match(html, /fetch\("\/api\/me"/);
  assert.match(html, /signedInSafetyReadiness/);
  assert.match(html, /signedInNeedsSafetyUpdate/);
  assert.match(html, /\[hidden\]\{display:none!important\}/);
  assert.match(html, /field\.hidden = true/);
  assert.match(html, /input\.disabled = true/);
  assert.match(html, /body\.signed_in_signup = true/);
  assert.match(html, /data\.profile_completion\?\.required/);
  assert.match(html, /update your emergency contact/);
  assert.match(html, /data\.code === "existing_account"/);
  assert.match(html, /existingAccountLogin/);
  assert.match(html, /Sign in with a magic link/);
  assert.doesNotMatch(html, /name="name" required/);
  assert.doesNotMatch(html, /name="emergency_contact_name" required/);
  assert.doesNotMatch(html, /name="emergency_contact_phone" required/);
});

test("rendered event detail page shows a public photo gallery with safe captions", () => {
  const html = renderEventPageHtml({
    slug: "demo-hours",
    title: "Demo Hours",
    description: "Community demo night",
    starts_at: "2026-07-23T01:00:00.000Z",
    venue_name: "Mesh Cowork",
    venue_address: "2020 Eye street",
    status: "closed"
  }, {
    photos: [
      {
        id: "pho_1",
        public_url: "/api/events/demo-hours/instances/inst_demo_hours_20260722/photos?key=event-photos%2Finst_demo_hours_20260722%2Fpho_1.jpg",
        caption: "Builders < shipping"
      },
      {
        id: "pho_2",
        public_url: "/api/events/demo-hours/instances/inst_demo_hours_20260722/photos?key=event-photos%2Finst_demo_hours_20260722%2Fpho_2.jpg",
        caption: null
      }
    ]
  });

  assert.match(html, /data-event-photo-gallery/);
  assert.match(html, /Photos from Demo Hours/);
  assert.match(html, /Builders &lt; shipping/);
  assert.doesNotMatch(html, /Builders < shipping/);
  assert.match(html, /alt="" loading="lazy"><figcaption>Builders &lt; shipping<\/figcaption>/);
  assert.match(html, /alt="Demo Hours photo 2"/);
  assert.equal((html.match(/class="event-gallery-photo"/g) || []).length, 2);
});

test("signed-in event signup route uses session identity through Participation and preserves instance role state", async () => {
  const currentUser = {
    id: "usr_session",
    email: "session@example.com",
    name: "Session User",
    first_name: "Session",
    last_name: "User",
    phone: "661-555-0000",
    metadata_json: null
  };
  const db = participationRouteDb({ currentUser });
  const response = await postEventSignup({
    request: new Request("https://hackthevalley.org/api/events/demo-hours/signups", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: "htv_session=test-session" },
      body: JSON.stringify({
        user_id: "usr_victim",
        person_id: "usr_victim",
        email: "victim@example.com",
        name: "Victim Person",
        signup_role: "demo"
      })
    }),
    env: { HTV_DB: db },
    params: { slug: "demo-hours" }
  });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.signup.signed_in, true);
  assert.equal(body.signup.user_id, "usr_session");
  assert.equal(body.signup.email, "session@example.com");
  assert.equal(body.signup.event_instance_id, "inst_demo_current");
  assert.equal(body.signup.signup_role, "demo");
  assert.equal(body.signup.emergency_contact_present, false);
  assert.equal(body.readiness.ready, false);
  assert.equal(body.profile_completion.required, true);
  assert.equal(body.profile_completion.code, "missing_safety_contact");
  assert.equal(body.profile_completion.url, "/me/?next=%2Fevents%2Fdemo-hours%23signup");
  assert.equal(db.signups.length, 1);
  assert.equal(db.signups[0].user_id, "usr_session");
  assert.match(db.signups[0].metadata_json, /"signup_role":"demo"/);
  assert.equal(db.participantEvents.some((event) => event.event_type === "signed_up" && event.source === "signed-in-event-signup"), true);
});

test("anonymous event signup blocks existing emails with login handoff and no duplicate signup", async () => {
  const db = participationRouteDb();
  const response = await postEventSignup({
    request: new Request("https://hackthevalley.org/api/events/demo-hours/signups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "SELECTED@example.com",
        signup_role: "demo"
      })
    }),
    env: { HTV_DB: db },
    params: { slug: "demo-hours" }
  });

  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "existing_account");
  assert.equal(body.existing_account, true);
  assert.equal(body.email, "selected@example.com");
  assert.equal(body.login_url, "/login/?next=%2Fevents%2Fdemo-hours%23signup");
  assert.equal(body.request_code_url, "/api/auth/request-code");
  assert.match(body.error, /Sign in with a magic link/);
  assert.equal(db.signups.length, 0);
  assert.equal(db.participantEvents.length, 0);
});

test("anonymous event signup creates a new account once and stores event-specific fields only on signup metadata", async () => {
  const db = participationRouteDb();
  const response = await postEventSignup({
    request: new Request("https://hackthevalley.org/api/events/demo-hours/signups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "New Builder",
        email: "new.builder@example.com",
        phone: "661-555-0101",
        school: "CSUB",
        signup_role: "demo",
        major: "Computer Science",
        dietary: "vegetarian",
        tshirt: "M",
        emergency_contact_name: "Helper Person",
        emergency_contact_phone: "661-555-0100"
      })
    }),
    env: { HTV_DB: db },
    params: { slug: "demo-hours" }
  });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.signup.email, "new.builder@example.com");
  assert.equal(body.profile_completion.required, false);
  assert.equal(db.signups.length, 1);
  assert.equal(db.signups[0].user_id, body.signup.user_id);
  const metadata = JSON.parse(db.signups[0].metadata_json);
  assert.deepEqual(metadata, {
    major: "Computer Science",
    dietary: "vegetarian",
    tshirt: "M",
    signup_role: "demo"
  });
  const user = db.usersByEmail.get("new.builder@example.com");
  assert.equal(user.name, "New Builder");
  assert.equal(user.school, "CSUB");
  assert.match(user.metadata_json, /"safety_profile"/);
  assert.equal(user.metadata_json.includes("Computer Science"), false);
  assert.equal(JSON.stringify(user).includes("Computer Science"), false);
});

test("check-in search ranks signed-up attendees first while searching all users", async () => {
  const db = {
    prepare(sql) {
      assert.match(sql, /FROM users u/);
      assert.match(sql, /LEFT JOIN signups s/);
      assert.match(sql, /s\.event_instance_id = \?/);
      assert.match(sql, /lower\(u\.email\) LIKE \?/);
      assert.match(sql, /ORDER BY is_signed_up DESC/);
      return {
        bind(eventInstanceId, likeA, likeB, likeC) {
          assert.equal(eventInstanceId, "inst_hack_hours_20260613");
          assert.equal(likeA, "%ada%");
          assert.equal(likeB, "%ada%");
          assert.equal(likeC, "%ada%");
          return this;
        },
        async all() {
          return {
            results: [
              { id: "usr_signed", email: "ada@example.com", name: "Ada Signed", is_signed_up: 1, signup_id: "sgn_1", checked_in_at: null },
              { id: "usr_global", email: "admiral@example.com", name: "Admiral Global", is_signed_up: 0, signup_id: null, checked_in_at: null }
            ]
          };
        }
      };
    }
  };

  const candidates = await searchCheckinCandidates(db, "hack-hours", { eventInstanceId: "inst_hack_hours_20260613", query: "ada" });
  assert.equal(candidates[0].id, "usr_signed");
  assert.equal(candidates[0].is_signed_up, 1);
  assert.equal(candidates[1].id, "usr_global");
});

test("check-in search defaults to all signups for the selected event instance", async () => {
  const db = {
    prepare(sql) {
      assert.match(sql, /FROM signups s/);
      assert.match(sql, /JOIN users u ON u\.id = s\.user_id/);
      assert.match(sql, /WHERE s\.event_slug = \? AND s\.event_instance_id = \?/);
      assert.doesNotMatch(sql, /lower\(u\.email\) LIKE/);
      return {
        bind(eventSlug, eventInstanceId) {
          assert.equal(eventSlug, "hack-hours");
          assert.equal(eventInstanceId, "inst_hack_hours_20260613");
          return this;
        },
        async all() {
          return {
            results: [
              { id: "usr_signed_a", email: "ada@example.com", name: "Ada Signed", is_signed_up: 1, signup_id: "sgn_1", checked_in_at: null },
              { id: "usr_signed_b", email: "grace@example.com", name: "Grace Signed", is_signed_up: 1, signup_id: "sgn_2", checked_in_at: "2026-06-13T16:00:00.000Z" }
            ]
          };
        }
      };
    }
  };

  const candidates = await searchCheckinCandidates(db, "hack-hours", { eventInstanceId: "inst_hack_hours_20260613", query: "" });
  assert.deepEqual(candidates.map((candidate) => candidate.id), ["usr_signed_a", "usr_signed_b"]);
  assert.equal(candidates.every((candidate) => candidate.is_signed_up === 1), true);
});

test("manual attendee check-in can create/signup/check in through Participation and stores checked_in event", () => {
  const platformSource = readFileSync(new URL("../functions/_lib/event-platform.js", import.meta.url), "utf8");
  const participationSource = readFileSync(new URL("../functions/_lib/domain/participation.js", import.meta.url), "utf8");
  assert.match(platformSource, /export async function checkInAttendee/);
  assert.match(platformSource, /await upsertSignup\(/);
  assert.match(platformSource, /checkInParticipant\(db, \{/);
  assert.match(participationSource, /eventType: "checked_in"/);
  assert.match(participationSource, /INSERT OR IGNORE INTO event_participant_events/);
  assert.match(participationSource, /eventInstanceId/);
});

test("admin check-in route allows selected existing users without emergency contact readiness", async () => {
  const db = participationRouteDb({ currentUser: { id: "usr_admin", email: "admin@example.com", name: "Admin User", metadata_json: null } });
  const response = await postEventCheckin({
    request: new Request("https://hackthevalley.org/api/events/demo-hours/checkins?instance_id=inst_demo_current", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: "htv_session=admin-session" },
      body: JSON.stringify({
        event_instance_id: "inst_demo_selected",
        user_id: "usr_existing",
        email: "attacker@example.com",
        name: "Body Override",
        actor: "forged-actor"
      })
    }),
    env: { HTV_DB: db },
    params: { slug: "demo-hours" }
  });

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.signup.user_id, "usr_existing");
  assert.equal(body.signup.event_instance_id, "inst_demo_selected");
  assert.equal(body.signup.email, "selected@example.com");
  assert.equal(db.signups.length, 1);
  assert.equal(db.signups[0].user_id, "usr_existing");
  assert.equal(db.signups[0].event_instance_id, "inst_demo_selected");
  assert.equal(db.signups[0].email, undefined);
  assert.equal(db.emergencyContacts.length, 0);
  const checkedIn = db.participantEvents.find((event) => event.event_type === "checked_in");
  assert.ok(checkedIn);
  assert.equal(checkedIn.user_id, "usr_existing");
  assert.equal(checkedIn.actor, "usr_admin");
});

test("admin check-in route still rejects brand-new manual attendees without emergency contact", async () => {
  const db = participationRouteDb({ currentUser: { id: "usr_admin", email: "admin@example.com", name: "Admin User", metadata_json: null } });
  const response = await postEventCheckin({
    request: new Request("https://hackthevalley.org/api/events/demo-hours/checkins?instance_id=inst_demo_current", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: "htv_session=admin-session" },
      body: JSON.stringify({
        event_instance_id: "inst_demo_selected",
        name: "No Contact",
        email: "new@example.com"
      })
    }),
    env: { HTV_DB: db },
    params: { slug: "demo-hours" }
  });

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /emergency contact name is required/);
  assert.equal(db.participantEvents.some((event) => event.event_type === "checked_in"), false);
});

test("admin portal exposes event check-in search and manual walk-up form", () => {
  const html = readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  assert.match(html, /id="event-checkin"/);
  assert.match(html, /id="checkin-event-title"/);
  assert.match(html, /currentCheckinEvent\.title/);
  assert.match(html, /id="checkin-search"/);
  assert.match(html, /placeholder="Search name or email/);
  assert.match(html, /id="manual-checkin-form"/);
  assert.match(html, /function loadCheckinCandidates/);
  assert.doesNotMatch(html, /if \(!query\) \{/);
  assert.match(html, /No signups match yet/);
  assert.match(html, /loadCheckinCandidates\(\)\.catch/);
  assert.match(html, /\/api\/events\/\$\{encodeURIComponent\(currentCheckinEvent\.slug\)\}\/checkins/);
  assert.match(html, /data-checkin-user=/);
  assert.match(html, /Not signed up for this instance yet/);
  assert.match(html, /function setCheckinError/);
  assert.doesNotMatch(html, /data-walkup-user=/);
  assert.doesNotMatch(html, /Use walk-up form/);
  assert.doesNotMatch(html, /function prefillManualCheckin/);
  assert.doesNotMatch(html, /checkInUser\(\{ user_id: button\.dataset\.checkinUser \}\)\.catch\(\(\) => \{\}\)/);
});

test("admin event form supports image uploads, signup role config, auto-populates slug, and avoids async currentTarget reset bug", () => {
  const html = readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  assert.match(html, /function slugify/);
  assert.match(html, /id="event-image-file"/);
  assert.match(html, /accept="image\/\*"/);
  assert.match(html, /id="upload-event-image"/);
  assert.match(html, /function uploadEventImage/);
  assert.match(html, /async function ensureEventImageUploaded/);
  assert.match(html, /await ensureEventImageUploaded\(form\)/);
  assert.match(html, /\/api\/events\/\$\{encodeURIComponent\(slug\)\}\/image/);
  assert.match(html, /name="image_url"/);
  assert.match(html, /name="page_content"/);
  assert.match(html, /name="signup_fields_json"/);
  assert.match(html, /signup_fields: parseJsonOrString\(data\.signup_fields_json\)/);
  assert.match(html, /eventForm\.signup_fields_json\.value = event\.signup_fields_json/);
  assert.doesNotMatch(html, /name="content_before"/);
  assert.doesNotMatch(html, /name="content_after"/);
  assert.match(html, /name="recurrence_rule"/);
  assert.match(html, /capacity" type="number"[^>]+placeholder="Leave blank/);
  assert.match(html, /const form = event\.currentTarget/);
  assert.match(html, /form\.reset\(\)/);
  assert.doesNotMatch(html, /event\.currentTarget\.reset\(\)/);
});

test("event migration adds users and user-linked signups instead of email-as-identity", () => {
  const migration = readFileSync(new URL("../migrations/0004_users_and_user_signups.sql", import.meta.url), "utf8");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS users/);
  assert.match(migration, /id TEXT PRIMARY KEY/);
  assert.match(migration, /email TEXT NOT NULL UNIQUE/);
  assert.match(migration, /user_id TEXT NOT NULL REFERENCES users\(id\)/);
  assert.doesNotMatch(migration, /UNIQUE\(event_slug, email\)/);
  assert.match(migration, /INSERT OR IGNORE INTO users/);
  assert.match(migration, /ALTER TABLE signups_new RENAME TO signups/);
});

test("event migrations add event-sourced participant state for check-in and future attendance facts", () => {
  const migration = readFileSync(new URL("../migrations/0005_event_participant_events.sql", import.meta.url), "utf8");
  const instanceMigration = readFileSync(new URL("../migrations/0006_event_instances_and_clean_hack_hours_slug.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS event_participant_events/);
  assert.match(migration, /event_slug TEXT NOT NULL REFERENCES events\(slug\)/);
  assert.match(migration, /user_id TEXT NOT NULL REFERENCES users\(id\)/);
  assert.match(migration, /event_type TEXT NOT NULL/);
  assert.match(migration, /data_json TEXT/);
  assert.match(migration, /occurred_at TEXT NOT NULL/);
  assert.match(migration, /INSERT OR IGNORE INTO event_participant_events/);
  assert.match(migration, /'signed_up'/);
  assert.match(instanceMigration, /event_instance_id TEXT REFERENCES event_instances\(id\)/);
  assert.match(instanceMigration, /CREATE VIEW IF NOT EXISTS event_participant_current_state/);
});

test("event migration supports reusable Hack Hours slug with concrete instances and scrubs generated suffix", () => {
  const migration = readFileSync(new URL("../migrations/0006_event_instances_and_clean_hack_hours_slug.sql", import.meta.url), "utf8");
  const admin = readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  const publicEvents = readFileSync(new URL("../public/events/index.html", import.meta.url), "utf8");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS event_instances/);
  assert.match(migration, /event_slug TEXT NOT NULL REFERENCES events\(slug\)/);
  assert.match(migration, /instance_key TEXT NOT NULL/);
  assert.match(migration, /UNIQUE\(event_slug, instance_key\)/);
  assert.match(migration, /'hack-hours', title/);
  assert.match(migration, /WHERE slug = 'hack-hours' \|\| '-1'/i);
  assert.match(migration, /DELETE FROM events WHERE slug = 'hack-hours' \|\| '-1'/i);
  assert.match(migration, /INSERT OR IGNORE INTO event_instances/);
  assert.match(admin, /eventInstanceRows\(events\)/);
  assert.match(admin, /data-cockpit-row=/);
  const oldSlugPattern = new RegExp("hack-hours" + "-1");
  assert.doesNotMatch(migration, oldSlugPattern);
  assert.doesNotMatch(admin, oldSlugPattern);
  assert.doesNotMatch(publicEvents, oldSlugPattern);
});

test("event list includes past and active instances for admin selection", async () => {
  const db = {
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        async all() {
          if (/FROM events e/.test(sql)) {
            return { results: [{ slug: "hack-hours", title: "Hack Hours", active_instance_id: "inst_hack_hours_20260620", active_instance_key: "2026-06-20", instance_count: 2 }] };
          }
          if (/FROM event_instances/.test(sql)) {
            assert.equal(this.args[0], "hack-hours");
            return { results: [
              { id: "inst_hack_hours_20260613", instance_key: "2026-06-13", status: "closed" },
              { id: "inst_hack_hours_20260620", instance_key: "2026-06-20", status: "open" }
            ] };
          }
          return { results: [] };
        }
      };
    }
  };

  const events = await listEvents(db, { includeArchived: true });
  assert.deepEqual(events[0].instances.map((instance) => instance.instance_key), ["2026-06-13", "2026-06-20"]);
});

test("event-platform keeps legacy event imports while exposing domain event helpers", async () => {
  assert.equal(typeof getEventSeries, "function");
  assert.equal(typeof listEventSeries, "function");
  assert.equal(typeof normalizeParticipationInput, "function");
  assert.equal(typeof registerParticipation, "function");
  assert.equal(typeof getParticipationCockpitReadModel, "function");

  const db = {
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        async all() {
          if (/FROM events e/.test(sql)) return { results: [{ slug: "demo-hours", title: "Demo Hours", status: "open" }] };
          if (/FROM event_instances/.test(sql)) return { results: [] };
          return { results: [] };
        }
      };
    }
  };

  const [legacyEvent] = await listEvents(db);
  const [domainEvent] = await listEventSeries(db);
  assert.equal(legacyEvent.kind, "event_series");
  assert.equal(domainEvent.kind, "event_series");
});

test("signup resolution chooses an open concrete event instance for a reusable slug", async () => {
  const sqls = [];
  const db = {
    prepare(sql) {
      sqls.push(sql);
      return {
        bind(...args) {
          this.args = args;
          return this;
        },
        async first() {
          assert.equal(this.args[0], "hack-hours");
          return { id: "inst_hack_hours_20260614", event_slug: "hack-hours", status: "open" };
        }
      };
    }
  };

  const instance = await resolveSignupEventInstance(db, "hack-hours");
  assert.equal(instance.id, "inst_hack_hours_20260614");
  assert.match(sqls.join("\n"), /FROM event_instances/);
  assert.match(sqls.join("\n"), /status = 'open'/);
});

test("event signup writes signups and participant events against a concrete instance through Participation", () => {
  const platformSource = readFileSync(new URL("../functions/_lib/event-platform.js", import.meta.url), "utf8");
  const participationSource = readFileSync(new URL("../functions/_lib/domain/participation.js", import.meta.url), "utf8");
  assert.match(platformSource, /registerParticipation\(db, \{/);
  assert.match(platformSource, /person: currentUser\?\.id \? currentUser : signup/);
  assert.doesNotMatch(platformSource, /id: input\.user_id/);
  assert.match(participationSource, /event_instance_id/);
  assert.match(participationSource, /ON CONFLICT\(event_instance_id, user_id\)/);
  assert.match(participationSource, /INSERT INTO signups/);
  assert.match(participationSource, /INSERT OR IGNORE INTO event_participant_events/);
  assert.match(participationSource, /eventInstance\.id/);
});

test("cockpit read construction delegates roster/readiness to Participation read model", () => {
  const platformSource = readFileSync(new URL("../functions/_lib/event-platform.js", import.meta.url), "utf8");
  const participationSource = readFileSync(new URL("../functions/_lib/domain/participation.js", import.meta.url), "utf8");
  const cockpitFunction = platformSource.slice(
    platformSource.indexOf("export async function getEventCockpit"),
    platformSource.indexOf("export async function getEventFollowupPacket")
  );
  const followupFunction = platformSource.slice(
    platformSource.indexOf("export async function getEventFollowupPacket"),
    platformSource.indexOf("export async function getUserById")
  );

  assert.match(platformSource, /getParticipationCockpitReadModel/);
  assert.match(cockpitFunction, /getParticipationCockpitReadModel\(db, \{ eventSlug, eventInstanceId \}\)/);
  assert.doesNotMatch(cockpitFunction, /FROM signups s/);
  assert.match(followupFunction, /getLegacyEventCockpitForFollowup\(db, eventSlug, eventInstanceId\)/);
  assert.doesNotMatch(followupFunction, /getEventCockpit\(db, eventSlug, eventInstanceId\)/);
  assert.match(participationSource, /export async function getParticipationCockpitReadModel/);
  assert.match(participationSource, /summarizeParticipationCockpitRoster/);
});

test("event migrations add editable page content and remove the superseded copy slots", () => {
  const fieldsMigration = readFileSync(new URL("../migrations/0002_event_page_fields.sql", import.meta.url), "utf8");
  const cleanupMigration = readFileSync(new URL("../migrations/0003_event_page_content.sql", import.meta.url), "utf8");
  assert.match(fieldsMigration, /ADD COLUMN image_url TEXT/i);
  assert.match(fieldsMigration, /ADD COLUMN recurrence_rule_json TEXT/i);
  assert.match(cleanupMigration, /ADD COLUMN page_content TEXT/i);
  assert.match(cleanupMigration, /DROP COLUMN content_before/i);
  assert.match(cleanupMigration, /DROP COLUMN content_after/i);
});

test("renderEventPageHtml returns a real event-specific page, not the events listing shell", () => {
  const html = renderEventPageHtml({
    slug: "hack-the-valley-2026",
    title: "Hack the Valley 2026",
    description: "Build in Bakersfield.",
    image_url: "/api/events/hack-the-valley-2026/image?key=event-images%2Fhack-the-valley-2026%2Fhero.png",
    page_content: "Agenda, prizes, venue details, and what to bring.",
    signup_fields_json: JSON.stringify({ role_label: "I want to", default_role: "attend", roles: [{ value: "attend", label: "Attend" }, { value: "demo", label: "Demo something" }] }),
    status: "open",
    starts_at: "2026-07-01T17:00:00.000Z",
    venue_name: "Bakersfield College"
  });

  assert.match(html, /data-event-detail-page="hack-the-valley-2026"/);
  assert.match(html, /Hack the Valley 2026/);
  assert.match(html, /Agenda, prizes, venue details, and what to bring/);
  assert.match(html, /<img[^>]+event-hero-image/);
  assert.match(html, /<form[^>]+id="signup-form"/);
  assert.match(html, /name="signup_role"/);
  assert.match(html, /Demo something/);
  assert.doesNotMatch(html, /School \/ org/i);
  assert.doesNotMatch(html, /School \/ organization/i);
  assert.doesNotMatch(html, /name="school"/);
  assert.doesNotMatch(html, /Notes/i);
  assert.doesNotMatch(html, /name="notes"/);
  assert.doesNotMatch(html, /name="year"/);
  assert.doesNotMatch(html, /id="upcoming-events-panel"/);
});

test("public events page uses clickable cards, signup CTAs, and a true event-detail mode", () => {
  const html = readFileSync(new URL("../public/events/index.html", import.meta.url), "utf8");
  assert.match(html, /event\.image_url/);
  assert.match(html, /object-contain/);
  assert.match(html, /id="events-hero"/);
  assert.match(html, /id="events-overview-grid"/);
  assert.match(html, /isEventDetailPath/);
  assert.match(html, /Event page/);
  assert.match(html, /event-card/);
  assert.match(html, /data-event-url="\/events\/\$\{encodeURIComponent\(event\.slug\)\}"/);
  assert.match(html, /#signup/);
  assert.match(html, />Sign up<\/a>/);
  assert.match(html, /event-page-content/);
  assert.match(html, /selected\.page_content/);
  assert.match(html, /id="signup-role-field"/);
  assert.match(html, /function renderSignupRoleField/);
  assert.match(html, /signup_fields_json/);
  assert.match(html, /pathEventMatch/);
  assert.doesNotMatch(html, /event-content-before/);
  assert.doesNotMatch(html, /event-content-after/);
});

test("Demo Hours launch packet and migrations point at the poster asset and corrected address", () => {
  const launchPacket = readFileSync(new URL("../references/htv-july22-launch-packet.md", import.meta.url), "utf8");
  const imageMigration = readFileSync(new URL("../migrations/0017_set_demo_hours_header_image.sql", import.meta.url), "utf8");
  const addressMigration = readFileSync(new URL("../migrations/0018_update_demo_hours_address.sql", import.meta.url), "utf8");
  assert.match(launchPacket, /'\/assets\/events\/demo-hours\.png'/);
  assert.match(launchPacket, /2020 Eye street/);
  assert.doesNotMatch(launchPacket, /2005 Eye/);
  assert.match(imageMigration, /WHERE slug = 'demo-hours'/);
  assert.match(imageMigration, /image_url = '\/assets\/events\/demo-hours\.png'/);
  assert.match(addressMigration, /venue_address = '2020 Eye street'/);
  assert.match(addressMigration, /WHERE slug = 'demo-hours'/);
  assert.match(addressMigration, /WHERE event_slug = 'demo-hours'/);
});

test("worker routes dynamic event APIs on the deployed Worker surface", async () => {
  const fakeDb = {
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        async all() {
          if (/FROM events e/.test(sql)) {
            return { results: [{ slug: "hack-hours-panera", title: "Hack Hours at Panera", status: "open" }] };
          }
          if (/FROM event_instances/.test(sql)) return { results: [{ id: "inst_hack_hours_panera", instance_key: "2026-06-20", status: "open" }] };
          return { results: [] };
        }
      };
    }
  };

  const response = await worker.fetch(
    new Request("https://hackthevalley.org/api/events", { method: "GET" }),
    { HTV_DB: fakeDb, ASSETS: { fetch: () => new Response("static miss", { status: 404 }) } },
    {}
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.events[0].slug, "hack-hours-panera");
});

test("worker exposes admin-only users API", async () => {
  const fakeDb = roleAwareAdminDb({
    role: "admin",
    users: [{ id: "usr_1", email: "ada@example.com", name: "Ada", created_at: "2026-01-01T00:00:00.000Z" }]
  });

  const unauthorized = await worker.fetch(
    new Request("https://hackthevalley.org/api/users", { method: "GET" }),
    { HTV_DB: fakeDb, HTV_ADMIN_TOKEN: "secret" },
    {}
  );
  assert.equal(unauthorized.status, 401);

  const response = await worker.fetch(
    new Request("https://hackthevalley.org/api/users", { method: "GET", headers: { cookie: "htv_session=test-session" } }),
    { HTV_DB: fakeDb, HTV_ADMIN_TOKEN: "secret" },
    {}
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.users[0].id, "usr_1");
  assert.equal(body.users[0].email, "ada@example.com");
});

test("wrangler runs the Worker before event page asset routing", () => {
  const config = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(config, /binding\s*=\s*"ASSETS"/);
  assert.match(config, /run_worker_first\s*=\s*\[[^\]]*"\/api\/\*"[^\]]*"\/events\/\*"[^\]]*\]/);
});

test("daily cron (sponsorship reminders) runs once a day", () => {
  const config = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(config, /crons\s*=\s*\["0 15 \* \* \*"\]/);
  assert.doesNotMatch(config, /\*\/15 \* \* \* \*/);
});

test("worker renders real per-event HTML and its approved gallery from D1 for /events/<slug>", async () => {
  const fakeDb = {
    prepare(sql) {
      return {
        bind(...args) {
          this.args = args;
          return this;
        },
        async first() {
          assert.match(sql, /FROM events\s+WHERE slug = \?/);
          assert.equal(this.args[0], "hack-the-valley-2026");
          return {
            slug: "hack-the-valley-2026",
            title: "Hack the Valley 2026",
            description: "Build in Bakersfield.",
            status: "closed",
            active_instance_id: null,
            image_url: "/image.png",
            page_content: "This is the real event page body."
          };
        },
        async all() {
          if (/FROM event_instances/.test(sql)) {
            assert.deepEqual(this.args, ["hack-the-valley-2026"]);
            return { results: [
              { id: "inst_htv_2025", event_slug: "hack-the-valley-2026", status: "closed", starts_at: "2025-09-12T16:00:00.000Z" },
              { id: "inst_htv_2026", event_slug: "hack-the-valley-2026", status: "closed", starts_at: "2026-09-12T16:00:00.000Z" },
              { id: "inst_htv_draft", event_slug: "hack-the-valley-2026", status: "draft", starts_at: null }
            ] };
          }
          if (/FROM event_photos/.test(sql)) {
            assert.deepEqual(this.args, ["hack-the-valley-2026", "inst_htv_2026"]);
            return { results: [{ id: "pho_htv", status: "approved", public_url: "/api/events/hack-the-valley-2026/instances/inst_htv_2026/photos?key=pho_htv" }] };
          }
          throw new Error(`Unexpected all() query: ${sql}`);
        }
      };
    }
  };

  const response = await worker.fetch(
    new Request("https://hackthevalley.org/events/hack-the-valley-2026", { method: "GET" }),
    { HTV_DB: fakeDb },
    {}
  );

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /data-event-detail-page="hack-the-valley-2026"/);
  assert.match(html, /This is the real event page body/);
  assert.match(html, /data-event-photo-gallery/);
  assert.match(html, /pho_htv/);
  assert.doesNotMatch(html, /id="upcoming-events-panel"/);
});

test("event signup writes an append-only signed_up participant event through Participation", () => {
  const source = readFileSync(new URL("../functions/_lib/domain/participation.js", import.meta.url), "utf8");
  assert.match(source, /INSERT OR IGNORE INTO event_participant_events/);
  assert.match(source, /eventType: "signed_up"/);
  assert.match(source, /evt_\$\{savedSignup\.id\}_signed_up/);
});

test("Resend import script pre-populates the users table without email IDs", () => {
  const script = readFileSync(new URL("../scripts/import-resend-users.mjs", import.meta.url), "utf8");
  assert.match(script, /RESEND_API_KEY/);
  assert.match(script, /RESEND_AUDIENCE_ID/);
  assert.match(script, /INSERT INTO users/);
  assert.match(script, /usr_/);
  assert.match(script, /ON CONFLICT\(email\)/);
  assert.match(script, /wrangler d1 execute HTV_DB --remote/);
});

function participantProfileDb() {
  const currentUser = {
    id: "usr_maya",
    email: "maya@example.com",
    name: "Maya Patel",
    first_name: "Maya",
    last_name: "Patel",
    phone: "661-555-0199",
    school: "CSUB",
    metadata_json: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    session_id: "ses_maya",
    session_expires_at: "2099-01-01T00:00:00.000Z"
  };
  const attendance = [
    {
      event_slug: "hack-hours",
      event_instance_id: "inst_hack_hours_2026_07_22_1800",
      event_type: "checked_in",
      occurred_at: "2026-07-23T01:05:00.000Z",
      event_title: "Hack Hours",
      event_status: "open",
      event_starts_at: "2026-07-23T01:00:00.000Z",
      event_ends_at: "2026-07-23T03:00:00.000Z",
      event_venue_name: "Panera Bread",
      event_venue_address: "10900 Stockdale Hwy, Bakersfield, CA",
      instance_key: "2026-07-22-1800",
      instance_title: "July Hack Hours",
      instance_status: "closed",
      instance_starts_at: "2026-07-23T01:00:00.000Z",
      instance_ends_at: "2026-07-23T03:00:00.000Z",
      venue_name: "Panera Bread",
      venue_address: "10900 Stockdale Hwy, Bakersfield, CA",
      signup_id: "signup_private",
      actor: "usr_admin",
      source: "admin",
      data_json: JSON.stringify({ admin_note: "private" })
    },
    {
      event_slug: "hack-hours",
      event_instance_id: "inst_hack_hours_2026_07_29_1800",
      event_type: "signed_up",
      occurred_at: "2026-07-25T01:05:00.000Z",
      event_title: "Hack Hours"
    },
    {
      event_slug: "hack-the-valley-2026",
      event_instance_id: "inst_htv_private",
      user_id: "usr_other",
      event_type: "checked_in",
      occurred_at: "2026-05-30T16:00:00.000Z",
      event_title: "Hack the Valley 2026"
    }
  ];
  const seenAttendanceSql = [];

  return {
    seenAttendanceSql,
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async first() {
          if (/FROM user_sessions us/.test(sql)) return currentUser;
          if (/SELECT \* FROM users WHERE id = \?/.test(sql)) return this.args[0] === currentUser.id ? currentUser : null;
          throw new Error(`Unexpected first() query: ${sql}`);
        },
        async all() {
          if (/FROM roles/.test(sql)) return { results: [] };
          if (/FROM event_participant_events epe/.test(sql)) {
            seenAttendanceSql.push(sql);
            assert.equal(this.args[0], currentUser.id);
            assert.match(sql, /epe\.user_id = \?/);
            assert.match(sql, /epe\.event_type = 'checked_in'/);
            assert.match(sql, /LEFT JOIN events e/);
            assert.match(sql, /LEFT JOIN event_instances ei/);
            return { results: attendance.filter((row) => row.event_type === "checked_in" && (row.user_id || currentUser.id) === currentUser.id) };
          }
          if (/FROM user_badges ub/.test(sql)) return { results: [] };
          if (/JOIN event_project_awards/.test(sql)) return { results: [] };
          if (/FROM project_members pm/.test(sql)) return { results: [] };
          if (/FROM signups s\s+JOIN events e/.test(sql)) return { results: [] };
          throw new Error(`Unexpected all() query: ${sql}`);
        }
      };
    }
  };
}

test("/api/me returns signed-in user's sanitized checked-in attendance history", async () => {
  const db = participantProfileDb();
  const response = await worker.fetch(
    new Request("https://hackthevalley.org/api/me", { method: "GET", headers: { cookie: "htv_session=test-session" } }),
    { HTV_DB: db },
    {}
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.user.id, "usr_maya");
  assert.equal(body.attendance.length, 1);
  assert.equal(db.seenAttendanceSql.length, 1);
  assert.deepEqual(Object.keys(body.attendance[0]).sort(), [
    "event_ends_at",
    "event_instance_id",
    "event_slug",
    "event_starts_at",
    "event_status",
    "event_title",
    "event_type",
    "instance_ends_at",
    "instance_key",
    "instance_starts_at",
    "instance_status",
    "instance_title",
    "occurred_at",
    "venue_address",
    "venue_name"
  ].sort());
  assert.equal(body.attendance[0].event_title, "Hack Hours");
  assert.equal(body.attendance[0].instance_title, "July Hack Hours");
  assert.equal(body.attendance[0].venue_name, "Panera Bread");
  assert.equal(body.attendance[0].instance_status, "closed");
  assert.equal(body.attendance[0].occurred_at, "2026-07-23T01:05:00.000Z");
  assert.equal(body.attendance.some((row) => row.event_type === "signed_up"), false);
  const serializedAttendance = JSON.stringify(body.attendance);
  assert.doesNotMatch(serializedAttendance, /maya@example\.com|661-555|usr_admin|signup_private|admin_note|source|actor|data_json|phone|email/i);
});

test("/api/me denies attendance history without a signed-in session", async () => {
  const response = await worker.fetch(
    new Request("https://hackthevalley.org/api/me", { method: "GET" }),
    { HTV_DB: participantProfileDb() },
    {}
  );

  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /not signed in/i);
  assert.equal(body.attendance, undefined);
});

test("/api/auth/logout revokes the current session token and clears the session cookie", async () => {
  const statements = [];
  const db = {
    prepare(sql) {
      return {
        args: [],
        bind(...args) { this.args = args; return this; },
        async run() {
          statements.push({ sql, args: this.args });
          return { success: true };
        }
      };
    }
  };

  const response = await worker.fetch(
    new Request("https://hackthevalley.org/api/auth/logout", { method: "POST", headers: { cookie: "htv_session=test-session" } }),
    { HTV_DB: db },
    {}
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /UPDATE user_sessions SET revoked_at = \?/);
  assert.equal(statements[0].args.length, 2);
  assert.notEqual(statements[0].args[1], "test-session");
  const setCookie = response.headers.get("set-cookie") || "";
  assert.match(setCookie, /htv_session=;/);
  assert.match(setCookie, /Max-Age=0/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
});

test("/api/auth/logout clears the browser cookie even when no session cookie is present", async () => {
  const response = await worker.fetch(
    new Request("https://hackthevalley.org/api/auth/logout", { method: "POST" }),
    {},
    {}
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.match(response.headers.get("set-cookie") || "", /htv_session=;.*Max-Age=0/);
});

test("profile page renders enriched attendance-history fields from /api/me", () => {
  const html = readFileSync(new URL("../public/me/index.html", import.meta.url), "utf8");
  assert.match(html, /Event history/);
  assert.match(html, /renderAttendance\(data\.attendance \|\| \[\]\)/);
  assert.match(html, /event\.event_title/);
  assert.match(html, /event\.instance_starts_at \|\| event\.event_starts_at/);
  assert.match(html, /event\.venue_name, event\.venue_address/);
  assert.match(html, /event\.instance_status \|\| event\.event_status/);
});

test("worker accepts admin event image uploads and serves uploaded event images publicly", async () => {
  const stored = new Map();
  const env = {
    HTV_DB: roleAwareAdminDb({ role: "admin" }),
    HTV_ADMIN_TOKEN: "secret",
    MAX_UPLOAD_MB: "1",
    SUBMISSIONS_MEDIA: {
      async put(key, body, options) {
        stored.set(key, { body: await new Response(body).text(), options });
      },
      async get(key) {
        const value = stored.get(key);
        if (!value) return null;
        return {
          body: value.body,
          httpEtag: "etag-test",
          customMetadata: value.options.customMetadata,
          writeHttpMetadata(headers) {
            headers.set("content-type", value.options.httpMetadata.contentType);
          }
        };
      }
    }
  };

  const uploadResponse = await worker.fetch(
    new Request("https://hackthevalley.org/api/events/hack-hours-panera/image?filename=hero.png", {
      method: "POST",
      headers: { cookie: "htv_session=test-session", "Content-Type": "image/png", "X-Filename": "hero.png" },
      body: "fake image"
    }),
    env,
    {}
  );
  assert.equal(uploadResponse.status, 200);
  const upload = await uploadResponse.json();
  assert.match(upload.image_url, /^\/api\/events\/hack-hours-panera\/image\?key=/);
  assert.match(upload.image_key, /^event-images\/hack-hours-panera\//);

  const imageResponse = await worker.fetch(
    new Request(`https://hackthevalley.org${upload.image_url}`, { method: "GET" }),
    env,
    {}
  );
  assert.equal(imageResponse.status, 200);
  assert.equal(imageResponse.headers.get("content-type"), "image/png");
  assert.equal(await imageResponse.text(), "fake image");
});

test("approved event photos are publicly readable by their recorded storage key", async () => {
  const storageKey = "event-photos/inst_demo_hours_20260722/pho_1-demo.jpg";
  const db = {
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        async first() {
          assert.match(sql, /FROM event_photos/);
          assert.match(sql, /kind = 'photo'/);
          assert.match(sql, /status = 'approved'/);
          assert.deepEqual(this.args, ["demo-hours", "inst_demo_hours_20260722", storageKey]);
          return {
            id: "pho_1",
            status: "approved",
            storage_key: storageKey,
            content_type: "image/jpeg"
          };
        }
      };
    }
  };
  const response = await getEventPhotos({
    request: new Request(`https://hackthevalley.org/api/events/demo-hours/instances/inst_demo_hours_20260722/photos?key=${encodeURIComponent(storageKey)}`),
    env: {
      HTV_DB: db,
      SUBMISSIONS_MEDIA: {
        async get(key) {
          assert.equal(key, storageKey);
          return {
            body: "photo bytes",
            httpEtag: "etag-photo",
            writeHttpMetadata(headers) { headers.set("content-type", "image/jpeg"); }
          };
        }
      }
    },
    params: { slug: "demo-hours", instanceId: "inst_demo_hours_20260722" }
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("cache-control"), "public, max-age=3600");
  assert.equal(await response.text(), "photo bytes");
});

test("unapproved or wrong-scope event photo keys are not read from storage", async () => {
  const storageKey = "event-photos/another-instance/private.jpg";
  let storageReads = 0;
  const db = {
    prepare(sql) {
      return {
        bind(...args) { this.args = args; return this; },
        async first() {
          assert.match(sql, /status = 'approved'/);
          assert.deepEqual(this.args, ["demo-hours", "inst_demo_hours_20260722", storageKey]);
          return null;
        }
      };
    }
  };
  const response = await getEventPhotos({
    request: new Request(`https://hackthevalley.org/api/events/demo-hours/instances/inst_demo_hours_20260722/photos?key=${encodeURIComponent(storageKey)}`),
    env: { HTV_DB: db, SUBMISSIONS_MEDIA: { async get() { storageReads += 1; return null; } } },
    params: { slug: "demo-hours", instanceId: "inst_demo_hours_20260722" }
  });

  assert.equal(response.status, 404);
  assert.equal(storageReads, 0);
});

test("approved event photo reads reject active content types and keyless listing stays private", async () => {
  const storageKey = "event-photos/inst_demo_hours_20260722/pho_bad.html";
  const db = {
    prepare() {
      return {
        bind() { return this; },
        async first() {
          return { id: "pho_bad", status: "approved", kind: "photo", storage_key: storageKey, content_type: "text/html" };
        }
      };
    }
  };
  const unsafeResponse = await getEventPhotos({
    request: new Request(`https://hackthevalley.org/api/events/demo-hours/instances/inst_demo_hours_20260722/photos?key=${encodeURIComponent(storageKey)}`),
    env: { HTV_DB: db, SUBMISSIONS_MEDIA: { async get() { return { body: "<script>alert(1)</script>", writeHttpMetadata() {} }; } } },
    params: { slug: "demo-hours", instanceId: "inst_demo_hours_20260722" }
  });
  assert.equal(unsafeResponse.status, 415);

  const privateListingResponse = await getEventPhotos({
    request: new Request("https://hackthevalley.org/api/events/demo-hours/instances/inst_demo_hours_20260722/photos"),
    env: { HTV_DB: roleAwareAdminDb({ role: "admin" }) },
    params: { slug: "demo-hours", instanceId: "inst_demo_hours_20260722" }
  });
  assert.equal(privateListingResponse.status, 401);
});
