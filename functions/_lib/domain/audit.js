import {
  parseJsonObject,
  stringOrNull
} from "./shared.js";

export function toAuditEvent(row = {}) {
  const metadata = parseJsonObject(row.metadata_json, {});
  const target = resolveRowTarget(row, metadata);

  return {
    id: stringOrNull(row.id),
    action: stringOrNull(row.action),
    actorUserId: stringOrNull(row.actor_user_id),
    targetType: target.targetType,
    targetId: target.targetId,
    approvalId: stringOrNull(metadata.approvalId ?? metadata.approval_id),
    targetEmail: stringOrNull(row.target_email) || stringOrNull(metadata.targetEmail ?? metadata.target_email),
    role: stringOrNull(row.role) || stringOrNull(metadata.role),
    scopeType: stringOrNull(row.scope_type) || stringOrNull(metadata.scopeType ?? metadata.scope_type) || "global",
    scopeId: stringOrNull(row.scope_id) || stringOrNull(metadata.scopeId ?? metadata.scope_id) || "*",
    metadata,
    createdAt: stringOrNull(row.created_at)
  };
}

export function buildAuditEvent({
  action,
  actorUserId = null,
  targetType = null,
  targetId = null,
  approvalId = null,
  scopeType = null,
  scopeId = null,
  metadata = {},
  createdAt = null
} = {}) {
  const normalizedAction = stringOrNull(action);
  if (!normalizedAction) {
    throw Object.assign(new Error("Audit action is required."), { status: 400, code: "validation_error" });
  }

  const normalizedCreatedAt = stringOrNull(createdAt) || new Date().toISOString();
  const event = {
    action: normalizedAction,
    actorUserId: stringOrNull(actorUserId),
    targetType: stringOrNull(targetType),
    targetId: stringOrNull(targetId),
    approvalId: stringOrNull(approvalId),
    scopeType: stringOrNull(scopeType),
    scopeId: stringOrNull(scopeId),
    metadata: parseJsonObject(metadata, {}),
    createdAt: normalizedCreatedAt
  };

  return {
    id: generateAuditEventId(),
    ...event
  };
}

export async function appendAuditEvent(db, event) {
  if (!db?.prepare) throw Object.assign(new Error("A D1 database binding is required."), { status: 500 });
  const normalized = normalizeAuditEvent(event);
  const storageMetadata = metadataForStorage(normalized);

  try {
    await insertGenericAuditEvent(db, normalized, storageMetadata);
  } catch (error) {
    if (!isMissingAuditEventsTableError(error)) throw error;
    await insertLegacyAdminAuditEvent(db, normalized, storageMetadata);
  }

  return { ...normalized, metadata: storageMetadata };
}

// The INSERT for an audit event, to run in the same D1 batch (transaction) as
// the change it records, so the change and its audit are stored together or
// not at all. Batched writes go to audit_events only (migration 0020): there
// is no legacy-table fallback inside a transaction.
export function auditEventStatement(db, event) {
  if (!db?.prepare) throw Object.assign(new Error("A D1 database binding is required."), { status: 500 });
  const normalized = normalizeAuditEvent(event);
  return genericAuditEventStatement(db, normalized, metadataForStorage(normalized));
}

function normalizeAuditEvent(event = {}) {
  const action = stringOrNull(event.action);
  if (!action) throw Object.assign(new Error("Audit action is required."), { status: 400, code: "validation_error" });

  const metadata = parseJsonObject(event.metadata, {});
  const targetType = stringOrNull(event.targetType ?? metadata.targetType ?? metadata.target_type);
  const targetId = stringOrNull(event.targetId ?? metadata.targetId ?? metadata.target_id);
  const approvalId = stringOrNull(event.approvalId ?? metadata.approvalId ?? metadata.approval_id);
  const createdAt = stringOrNull(event.createdAt) || new Date().toISOString();

  return {
    id: stringOrNull(event.id) || generateAuditEventId(),
    action,
    actorUserId: stringOrNull(event.actorUserId),
    targetType,
    targetId,
    approvalId,
    metadata,
    scopeType: stringOrNull(event.scopeType ?? metadata.scopeType ?? metadata.scope_type) || targetType || "global",
    scopeId: stringOrNull(event.scopeId ?? metadata.scopeId ?? metadata.scope_id) || targetId || "*",
    createdAt
  };
}

function metadataForStorage(event) {
  return {
    ...event.metadata,
    ...(event.targetType ? { targetType: event.targetType } : {}),
    ...(event.targetId ? { targetId: event.targetId } : {}),
    ...(event.approvalId ? { approvalId: event.approvalId } : {})
  };
}

async function insertGenericAuditEvent(db, event, metadata) {
  await genericAuditEventStatement(db, event, metadata).run();
}

function genericAuditEventStatement(db, event, metadata) {
  return db.prepare(`
    INSERT INTO audit_events (id, action, actor_user_id, target_type, target_id, scope_type, scope_id, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    event.id,
    event.action,
    event.actorUserId,
    event.targetType,
    event.targetId,
    event.scopeType,
    event.scopeId,
    JSON.stringify(metadata),
    event.createdAt
  );
}

async function insertLegacyAdminAuditEvent(db, event, metadata) {
  await db.prepare(`
    INSERT INTO admin_audit_events (id, action, actor_user_id, target_user_id, target_email, role, scope_type, scope_id, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    event.id,
    event.action,
    event.actorUserId,
    targetUserId(event),
    stringOrNull(metadata.targetEmail ?? metadata.target_email),
    stringOrNull(metadata.role),
    event.scopeType,
    event.scopeId,
    JSON.stringify(metadata),
    event.createdAt
  ).run();
}

function isMissingAuditEventsTableError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return message.includes("no such table") && message.includes("audit_events");
}

function targetUserId(event) {
  return event.targetType === "user" ? event.targetId : null;
}

function generateAuditEventId() {
  if (globalThis.crypto?.randomUUID) {
    return `audit_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
  }

  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  return `audit_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function resolveRowTarget(row, metadata) {
  const rowTargetType = stringOrNull(row.target_type);
  const rowTargetId = stringOrNull(row.target_id);
  if (rowTargetType && rowTargetId) {
    return { targetType: rowTargetType, targetId: rowTargetId };
  }

  const metadataTargetType = stringOrNull(metadata.targetType ?? metadata.target_type);
  const metadataTargetId = stringOrNull(metadata.targetId ?? metadata.target_id);
  if (metadataTargetType && metadataTargetId) {
    return { targetType: metadataTargetType, targetId: metadataTargetId };
  }

  const rowTargetUserId = stringOrNull(row.target_user_id);
  if (rowTargetUserId) {
    return { targetType: "user", targetId: rowTargetUserId };
  }

  const scopeTargetType = scopedTargetType(row.scope_type, row.scope_id);
  const scopeTargetId = scopedTargetId(row.scope_id);
  if (scopeTargetType && scopeTargetId) {
    return { targetType: scopeTargetType, targetId: scopeTargetId };
  }

  return { targetType: metadataTargetType, targetId: metadataTargetId };
}

function scopedTargetType(scopeType, scopeId) {
  const normalizedScopeType = stringOrNull(scopeType);
  const normalizedScopeId = stringOrNull(scopeId);
  if (!normalizedScopeType || normalizedScopeType === "global") return null;
  if (!normalizedScopeId || normalizedScopeId === "*") return null;
  return normalizedScopeType;
}

function scopedTargetId(scopeId) {
  const normalizedScopeId = stringOrNull(scopeId);
  if (!normalizedScopeId || normalizedScopeId === "*") return null;
  return normalizedScopeId;
}
