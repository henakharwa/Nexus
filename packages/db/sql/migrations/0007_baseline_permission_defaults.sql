-- 0001_baseline.sql was edited on 2026-10-08 (commit a74ee26, "Add workspace
-- content permissions") after databases had already applied it. The edit
-- only changed the default values of the two permission columns below, so
-- databases migrated before then kept the old defaults and logged
-- "migration 0001_baseline changed after it was applied" on every start.
--
-- This brings those databases to the edited definition and records the
-- edited file's checksum, which ends the warning. On databases created
-- after the edit both statements change nothing.
ALTER TABLE workspace_permission_policies
  ALTER COLUMN admin_permissions SET DEFAULT '{"connectTools":true,"createAgents":true,"publishAgents":true,"manageWorkflows":true,"manageMemory":true,"manageArtifacts":true,"approveActions":true,"github":true,"slack":true,"linear":true,"notion":true,"figma":true}'::jsonb,
  ALTER COLUMN editor_permissions SET DEFAULT '{"connectTools":true,"createAgents":false,"publishAgents":false,"manageWorkflows":false,"manageMemory":true,"manageArtifacts":true,"approveActions":false,"github":true,"slack":true,"linear":true,"notion":true,"figma":true}'::jsonb;

-- 3a818b... is 0001_baseline.sql before the edit; 0457a9... is after it.
UPDATE schema_migrations
SET checksum = '0457a93a2c6161ddd5ae99bc50e606284ae5d9af1f9c212ba7a34ae72f43dffc'
WHERE version = '0001' AND checksum = '3a818bdbbad064feb37993deca713442e2b3c71ffa7dbcc8b6ef1adbd8d74ea6';
