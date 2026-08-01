// The main application state schema version, in its own module so that both
// state-schema.cjs and initial-state.cjs can import it.
//
// state-schema.cjs already requires initial-state.cjs, so the constant cannot
// live in either one without a require cycle. It previously lived in
// state-schema.cjs while initial-state.cjs hard-coded the same literal, and that
// duplication was load-bearing: loadRecoverableState writes a fresh install's
// state without validating or migrating it, so a bumped constant produced a
// stale-version file on disk that then failed INVALID_STATE on the next boot
// rather than failing at write time.
//
// Migration steps deliberately keep their own literal target versions -- a
// migration is pinned to the shape it produces and must not follow this value.
const CURRENT_SCHEMA_VERSION = 10;

// The oldest schema ProduDash can migrate forward. Anything below this is
// refused rather than guessed at.
const MINIMUM_SUPPORTED_SCHEMA_VERSION = 2;

module.exports = { CURRENT_SCHEMA_VERSION, MINIMUM_SUPPORTED_SCHEMA_VERSION };
