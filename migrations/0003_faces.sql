-- phase: expand
-- Face data stays private to a Network subject and never enters Search, prompts or Bench.
CREATE TABLE face_consents (
    id text PRIMARY KEY,
    subject text NOT NULL,
    feature text NOT NULL CHECK (feature IN ('verify', 'find', 'cast', 'library')),
    scope text NOT NULL DEFAULT '',
    text_version text NOT NULL,
    signature text NOT NULL,
    granted_at timestamptz NOT NULL,
    revoked_at timestamptz,
    last_used_at timestamptz NOT NULL,
    purpose_ends_at timestamptz,
    CHECK (subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CHECK (length(scope) <= 160),
    CHECK (length(signature) BETWEEN 1 AND 160)
);
CREATE UNIQUE INDEX face_consents_active ON face_consents (subject, feature, scope) WHERE revoked_at IS NULL;
CREATE INDEX face_consents_retention ON face_consents (last_used_at, purpose_ends_at);

CREATE TABLE face_templates (
    subject text NOT NULL,
    feature text NOT NULL,
    scope text NOT NULL DEFAULT '',
    ciphertext text NOT NULL,
    created_at timestamptz NOT NULL,
    last_used_at timestamptz NOT NULL,
    PRIMARY KEY (subject, feature, scope)
);
-- A separate table holds only this person's own Vision uploads and encrypted face vectors.
CREATE TABLE face_media (
    id text PRIMARY KEY,
    subject text NOT NULL,
    image_ciphertext text NOT NULL,
    image_mime text NOT NULL,
    vectors_ciphertext text NOT NULL,
    created_at timestamptz NOT NULL,
    last_used_at timestamptz NOT NULL
);
CREATE INDEX face_media_owner ON face_media (subject, created_at DESC);

CREATE TABLE face_tags (
    id text PRIMARY KEY,
    subject text NOT NULL,
    channel text NOT NULL,
    media_ref text NOT NULL,
    created_at timestamptz NOT NULL,
    last_used_at timestamptz NOT NULL
);
CREATE INDEX face_tags_channel ON face_tags (channel, created_at DESC);
CREATE INDEX face_tags_subject ON face_tags (subject, channel);

CREATE TABLE face_clusters (
    id text PRIMARY KEY,
    subject text NOT NULL,
    media_id text NOT NULL REFERENCES face_media (id) ON DELETE CASCADE,
    vector_ciphertext text NOT NULL,
    group_id text NOT NULL,
    label text,
    excluded boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL,
    last_used_at timestamptz NOT NULL
);
CREATE INDEX face_clusters_owner ON face_clusters (subject, created_at DESC);
