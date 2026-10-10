-- Human-readable provenance for each immutable content snapshot. Rows written before this
-- migration predate the content package, so the columns stay NULL for them.
ALTER TABLE content_versions ADD COLUMN content_semver text;
ALTER TABLE content_versions ADD COLUMN manifest_version text;
ALTER TABLE content_versions ADD COLUMN lifecycle_status text;
