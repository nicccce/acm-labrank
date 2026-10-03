-- Block old team writers while normalizing and merging their member sets.
SELECT pg_advisory_xact_lock(73192410);
--> statement-breakpoint
LOCK TABLE "teams", "team_memberships", "team_events" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DROP INDEX "team_active_roster";--> statement-breakpoint
UPDATE "teams" t SET "roster_key" = coalesce((
  SELECT string_agg(m.user_id::text, ',' ORDER BY m.user_id)
  FROM "team_memberships" m WHERE m.team_id=t.id AND m.left_at IS NULL
), '');
--> statement-breakpoint
-- Prefer an active team, otherwise the oldest archived team. Keep the surviving
-- team's name and current roster, and carry over all membership/event history.
CREATE TEMP TABLE team_roster_merges ON COMMIT DROP AS
SELECT id AS duplicate_id, keep_id FROM (
  SELECT id, first_value(id) OVER (
    PARTITION BY roster_key ORDER BY (archived_at IS NULL) DESC, created_at, id
  ) AS keep_id FROM "teams"
) ranked WHERE id<>keep_id;
--> statement-breakpoint
UPDATE "team_memberships" m SET left_at=coalesce(m.left_at,clock_timestamp())
FROM team_roster_merges d WHERE m.team_id=d.duplicate_id;
--> statement-breakpoint
UPDATE "team_memberships" m SET team_id=d.keep_id
FROM team_roster_merges d WHERE m.team_id=d.duplicate_id;
--> statement-breakpoint
UPDATE "team_events" e SET team_id=d.keep_id,
  details=e.details || jsonb_build_object('mergedFromTeamId',d.duplicate_id)
FROM team_roster_merges d WHERE e.team_id=d.duplicate_id;
--> statement-breakpoint
UPDATE "teams" SET version=version+1
WHERE id IN (SELECT keep_id FROM team_roster_merges);
--> statement-breakpoint
DELETE FROM "teams" t USING team_roster_merges d WHERE t.id=d.duplicate_id;
--> statement-breakpoint
CREATE UNIQUE INDEX "team_roster_unique" ON "teams" USING btree ("roster_key");--> statement-breakpoint
ALTER TABLE "teams" DROP CONSTRAINT "teams_owner_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "teams" DROP COLUMN "owner_id";
