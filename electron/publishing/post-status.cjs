const { AppError } = require("../errors.cjs");

// The post-plan state machine, in one place.
//
// The transition rules used to live only inside store.cjs methods, with the
// renderer re-deriving them by hand in studio.js. Both now read this table.
const POST_PLAN_STATUSES = Object.freeze({
  NEEDS_APPROVAL: "needs_approval",
  APPROVED_FOR_MANUAL_EXPORT: "approved_for_manual_export",
  APPROVED_FOR_OFFICIAL_API: "approved_for_official_api",
  EXPORT_READY: "export_ready",
  // Dispatch is in flight. Reaching this state means bytes may already have
  // been sent, so recovery has to check the provider rather than assume.
  DISPATCHING: "dispatching",
  PUBLISHED: "published",
  DISPATCH_FAILED: "dispatch_failed",
  CANCELED: "canceled"
});

const STATUS_VALUES = Object.freeze(new Set(Object.values(POST_PLAN_STATUSES)));

const TRANSITIONS = Object.freeze({
  [POST_PLAN_STATUSES.NEEDS_APPROVAL]: Object.freeze([
    POST_PLAN_STATUSES.APPROVED_FOR_MANUAL_EXPORT,
    POST_PLAN_STATUSES.APPROVED_FOR_OFFICIAL_API,
    POST_PLAN_STATUSES.CANCELED
  ]),
  [POST_PLAN_STATUSES.APPROVED_FOR_MANUAL_EXPORT]: Object.freeze([POST_PLAN_STATUSES.EXPORT_READY, POST_PLAN_STATUSES.CANCELED]),
  [POST_PLAN_STATUSES.APPROVED_FOR_OFFICIAL_API]: Object.freeze([POST_PLAN_STATUSES.DISPATCHING, POST_PLAN_STATUSES.CANCELED]),
  [POST_PLAN_STATUSES.DISPATCHING]: Object.freeze([POST_PLAN_STATUSES.PUBLISHED, POST_PLAN_STATUSES.DISPATCH_FAILED]),
  // A failed dispatch can be retried; idempotency keys make that safe.
  [POST_PLAN_STATUSES.DISPATCH_FAILED]: Object.freeze([POST_PLAN_STATUSES.DISPATCHING, POST_PLAN_STATUSES.CANCELED]),
  // Terminal. A published post is not un-publishable from here, and a canceled
  // or exported plan does not reopen.
  [POST_PLAN_STATUSES.PUBLISHED]: Object.freeze([]),
  [POST_PLAN_STATUSES.EXPORT_READY]: Object.freeze([]),
  [POST_PLAN_STATUSES.CANCELED]: Object.freeze([])
});

// Editing is locked the moment a plan is approved, so the approved snapshot
// always describes exactly what was reviewed.
const EDITABLE_STATUSES = Object.freeze(new Set([POST_PLAN_STATUSES.NEEDS_APPROVAL]));

// States from which the official-API dispatcher may run.
const DISPATCHABLE_STATUSES = Object.freeze(new Set([POST_PLAN_STATUSES.APPROVED_FOR_OFFICIAL_API, POST_PLAN_STATUSES.DISPATCH_FAILED]));

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to));
}

function assertTransition(from, to) {
  if (from === to) return false;
  if (!canTransition(from, to)) {
    throw new AppError("INVALID_TRANSITION", "That publishing action is not available for this plan.");
  }
  return true;
}

module.exports = {
  DISPATCHABLE_STATUSES,
  EDITABLE_STATUSES,
  POST_PLAN_STATUSES,
  STATUS_VALUES,
  TRANSITIONS,
  assertTransition,
  canTransition
};
