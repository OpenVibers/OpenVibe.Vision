-- phase: expand
-- pgvector is not required by the current Vision database; score owner-scoped JSON vectors in JS for v1.
CREATE TABLE vision_private_index (
    owner text COLLATE "C" NOT NULL,
    item_id text COLLATE "C" NOT NULL,
    result_url text,
    image_sha256 text COLLATE "C" NOT NULL,
    embedding jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner, item_id)
);
CREATE INDEX vision_private_index_owner ON vision_private_index (owner, created_at DESC);
