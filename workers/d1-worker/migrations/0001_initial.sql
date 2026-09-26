-- SampleMap GlobalSampleIndex — D1 schema (Step 16F).
--
-- Two tables implement the 16E design (§5, §6, §9, §11):
--   * sample_ref — the sampleId → content[(hash,version)] fast-path key.
--   * content    — one canonical row per content identity, embedding the
--     analysis + map + similarity (matching GlobalContentRecord).
--
-- Hard invariants (encoded in the schema):
--   * Identity is exclusively (content_hash, content_hash_version) → PK.
--   * A single content identity is never duplicated → content PK.
--   * A sampleId maps to exactly one content identity → sample_ref PK.
--   * gate_passed is structurally required to be TRUE (metadata-only trust,
--     §15 of STEP16E_DESIGN).
--   * No audio bytes anywhere — only hashes, floats, version tokens, and
--     small JSON-encoded metadata arrays (TEXT columns). Never BLOB.

CREATE TABLE sample_ref (
  sample_id            TEXT    PRIMARY KEY,
  content_hash         TEXT    NOT NULL,
  content_hash_version TEXT    NOT NULL,
  published_at         TEXT    NOT NULL,
  UNIQUE (content_hash, content_hash_version, sample_id)
);

-- Sample→content and content→samples lookups (§7/§8 of 16E).
CREATE INDEX idx_sample_ref_content
  ON sample_ref (content_hash, content_hash_version);

CREATE TABLE content (
  content_hash          TEXT    NOT NULL,
  content_hash_version  TEXT    NOT NULL,
  -- analysis (classification / map / similarity / version metadata)
  classification_version TEXT   NOT NULL,
  primary_class         TEXT    NOT NULL,
  confidence            REAL    NOT NULL,
  secondary_classes     TEXT    NOT NULL,
  analysis_version      TEXT    NOT NULL,
  analysis_build        TEXT    NOT NULL,
  analysis_source_format TEXT   NOT NULL,
  gate_passed           INTEGER NOT NULL CHECK (gate_passed = 1),
  -- map (version coupled to coords — never bare coords)
  map_version           TEXT    NOT NULL,
  map_x                 REAL    NOT NULL,
  map_y                 REAL    NOT NULL,
  -- similarity (version coupled to values)
  similarity_version    TEXT    NOT NULL,
  similarity_values     TEXT    NOT NULL,
  -- representative / version set
  representative_version TEXT   NOT NULL DEFAULT 'representative-v1',
  -- features (metadata only; enables server-side recompute of derived values)
  features              TEXT    NOT NULL,
  -- provenance
  file_hash             TEXT,
  first_published_at    TEXT    NOT NULL,
  updated_at            TEXT,
  PRIMARY KEY (content_hash, content_hash_version)
);

-- Map viewport by version is the primary map access (§12): bounded, versioned.
CREATE INDEX idx_content_map_version
  ON content (map_version, map_x, map_y);

-- Optional classification filter on the map viewport.
CREATE INDEX idx_content_map_class
  ON content (map_version, primary_class, map_x, map_y);
