-- Rebuild the derived assignee activity projection with explicit JSON null
-- membership states. The immutable raw activity_events table is unchanged.
--
-- The versioned Rust hook `backfill_assignee_activity_projection_v4` owns the
-- deterministic created_at/id replay, fixed five-minute windows, actor and
-- lifecycle boundaries, and stable first-event projection IDs. Keep that hook
-- frozen with this migration after release.
SELECT 1;
