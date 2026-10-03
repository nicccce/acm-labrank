ALTER TABLE "submission_attributions" DROP CONSTRAINT "submission_attributions_pkey";--> statement-breakpoint
ALTER TABLE "submission_attributions" ALTER COLUMN "rule_version" SET DEFAULT 'personal-v2';--> statement-breakpoint
ALTER TABLE "submission_attributions" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "submission_attributions" ADD COLUMN "share_divisor" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "attribution_submission_user" ON "submission_attributions" USING btree ("submission_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "attribution_unassigned" ON "submission_attributions" USING btree ("submission_id") WHERE "submission_attributions"."user_id" IS NULL;--> statement-breakpoint
ALTER TABLE "submission_attributions" ADD CONSTRAINT "attribution_share_divisor" CHECK ("submission_attributions"."share_divisor">0);
--> statement-breakpoint
-- Rebuild collected CF history from actual authors without refetching.
DELETE FROM submission_attributions a USING submissions s WHERE a.submission_id=s.id AND s.platform='codeforces';
--> statement-breakpoint
WITH authors AS (
  SELECT s.id,s.platform,s.subject_evidence,ARRAY(
  SELECT DISTINCT CASE WHEN s.platform='codeforces' THEN lower(key) ELSE key END AS key
  FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(s.subject_evidence->'authorAccountKeys')='array' THEN s.subject_evidence->'authorAccountKeys' ELSE '[]'::jsonb END) AS keys(key)
  WHERE btrim(key)<>'' ORDER BY key
) AS author_keys
  FROM submissions s WHERE s.platform='codeforces'
), eligible AS (
  SELECT s.* FROM authors s WHERE cardinality(s.author_keys)>0
    AND coalesce(s.subject_evidence->>'ghost','false')<>'true'
    AND CASE WHEN s.platform='codeforces' THEN
      NOT (s.subject_evidence ? 'authorMembers') OR s.author_keys=ARRAY(
        SELECT DISTINCT lower(member->>'handle') AS key
        FROM jsonb_array_elements(s.subject_evidence->'authorMembers') AS members(member)
        WHERE btrim(member->>'handle')<>'' ORDER BY key
      )
    ELSE cardinality(s.author_keys)=1
      AND NOT (s.subject_evidence ? 'teamId') AND NOT (s.subject_evidence ? 'teamName')
      AND (NOT (s.subject_evidence ? 'authorMembers') OR jsonb_array_length(s.subject_evidence->'authorMembers')=1)
    END
), credits AS (
  SELECT DISTINCT ON (s.id,b.user_id) s.id AS submission_id,b.user_id,b.account_id,
    cardinality(s.author_keys) AS share_divisor,
    CASE WHEN s.platform='codeforces' AND (cardinality(s.author_keys)>1 OR s.subject_evidence ? 'teamId' OR s.subject_evidence ? 'teamName') THEN 'verified_cf_shared' ELSE 'verified_person' END AS method
  FROM eligible s CROSS JOIN LATERAL unnest(s.author_keys) AS author(key)
  JOIN platform_account_aliases a ON a.platform=s.platform AND a.key=author.key
  JOIN platform_bindings b ON b.account_id=a.account_id
  ORDER BY s.id,b.user_id,b.account_id
)
INSERT INTO submission_attributions(submission_id,user_id,account_id,share_divisor,method,rule_version)
SELECT submission_id,user_id,account_id,share_divisor,method,'personal-v2' FROM credits
UNION ALL
SELECT s.id,NULL::uuid,NULL::uuid,1,'unassigned','personal-v2' FROM authors s
WHERE NOT EXISTS (SELECT 1 FROM credits c WHERE c.submission_id=s.id);
