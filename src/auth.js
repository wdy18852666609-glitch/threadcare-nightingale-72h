const ROLE_PERMISSIONS = {
  patient: new Set(["read:patient_facing", "create:patient_session", "read:conversation", "write:conversation", "submit:consultation_feedback", "start:consultation", "transcribe:audio"]),
  staff: new Set([
    "read:clinical_team",
    "write:staff_note",
    "revert:staff_note",
    "write:comment",
    "update:task",
    "read:conversation",
    "write:conversation",
    "summarize:conversation",
    "transcribe:audio"
  ]),
  clinician: new Set([
    "read:clinical_team",
    "write:clinician_note",
    "write:comment",
    "decide:highlight",
    "create:task",
    "update:task",
    "revert:clinician_note",
    "read:conversation",
    "write:conversation",
    "summarize:conversation",
    "start:consultation",
    "close:consultation",
    "transcribe:audio"
  ]),
  admin: new Set(["read:audit"])
};

export function actorFromRequest(request) {
  const role = request.headers["x-role"] || "clinician";
  const actorId = request.headers["x-user-id"] || `${role}-demo`;
  const clinicId = request.headers["x-clinic-id"] || "clinic-sg-01";
  if (!ROLE_PERMISSIONS[role]) {
    const error = new Error("Unknown role");
    error.status = 401;
    throw error;
  }
  return { role, actorId, clinicId };
}

export function actorForAccount({ role, actorId, clinicId = "clinic-sg-01", patientId = null, displayName = "" }) {
  if (!ROLE_PERMISSIONS[role]) {
    const error = new Error("Unknown role");
    error.status = 401;
    throw error;
  }
  return { role, actorId, clinicId, patientId, displayName };
}

export function requirePermission(actor, permission) {
  if (!ROLE_PERMISSIONS[actor.role]?.has(permission)) {
    const error = new Error(`Role ${actor.role} cannot ${permission}`);
    error.status = 403;
    throw error;
  }
}

export function assertClinicScope(actor, clinicId) {
  if (actor.clinicId !== clinicId) {
    const error = new Error("Resource is outside the actor's clinic scope");
    error.status = 403;
    throw error;
  }
}

export function canReadEntry(actor, entry) {
  if (actor.role === "patient") {
    return entry.visibility === "patient";
  }
  if (actor.role === "admin") {
    return false;
  }
  return entry.visibility === "patient" || entry.visibility === "clinical_team";
}
