-- Add per-angle Tried and Flash tracking to user_route_data.
-- Existing column: angle_sends int[]
-- New columns:
--   angle_flashes  — angles the user flashed (subset of angle_sends)
--   angle_attempts — angles the user has tried (superset of angle_sends)
--
-- State for an angle is derived in the app:
--   flash   ∈ angle_flashes
--   sent    ∈ angle_sends and not in angle_flashes
--   tried   ∈ angle_attempts and not in angle_sends
--   empty   not in any array

ALTER TABLE user_route_data
  ADD COLUMN IF NOT EXISTS angle_flashes  int[] DEFAULT '{}'::int[],
  ADD COLUMN IF NOT EXISTS angle_attempts int[] DEFAULT '{}'::int[];
