-- phase: expand
-- VIS-6's last item: an unsafe-image review sorts into exactly three categories.
--   fine          allowed, including nudity
--   sex_acts      never public; kept for its owner, hidden from every public surface
--   minor_sexual  always blocked; the object is quarantined and an operator report row is made
-- No image bytes are stored. A review keeps the caller's object reference, a sha256 as evidence, the
-- category and the engine's provenance. A category-3 review always has one operator report row; the
-- report is internal to OpenVibe and never sent anywhere automatically.
CREATE TABLE vision_image_reviews (
    id             text COLLATE "C" PRIMARY KEY,              -- vir_ + ULID
    subject        text COLLATE "C",                          -- the person who submitted it, when there is one
    requester      text COLLATE "C" NOT NULL,
    object_type    text COLLATE "C" NOT NULL DEFAULT 'unknown',
    object_id      text COLLATE "C",
    owner_subject  text COLLATE "C",
    image_sha256   text COLLATE "C",
    image_mime     text COLLATE "C",
    image_bytes    bigint,
    preview_url    text,
    category       text COLLATE "C" NOT NULL,
    plain_words    text COLLATE "C" NOT NULL,
    action         text COLLATE "C" NOT NULL,
    is_public      boolean NOT NULL DEFAULT false,
    reason         text,
    cue            text COLLATE "C",
    engine         text COLLATE "C" NOT NULL,
    model          text COLLATE "C",
    provider       text COLLATE "C",
    route          text COLLATE "C",
    confidence     numeric(5, 4),
    cost_usd       numeric(12, 6) NOT NULL DEFAULT 0,
    latency_ms     integer NOT NULL DEFAULT 0,
    status         text COLLATE "C" NOT NULL DEFAULT 'auto',
    reviewed_by    text COLLATE "C",
    reviewed_at    timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT vision_image_reviews_id CHECK (id ~ '^vir_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT vision_image_reviews_subject CHECK (subject IS NULL OR subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT vision_image_reviews_owner CHECK (owner_subject IS NULL OR owner_subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT vision_image_reviews_requester CHECK (length(requester) BETWEEN 1 AND 160),
    CONSTRAINT vision_image_reviews_object_type CHECK (length(object_type) BETWEEN 1 AND 80),
    CONSTRAINT vision_image_reviews_object_id CHECK (object_id IS NULL OR length(object_id) <= 300),
    CONSTRAINT vision_image_reviews_category CHECK (category IN ('fine', 'sex_acts', 'minor_sexual')),
    CONSTRAINT vision_image_reviews_action CHECK (action IN ('allow', 'hide', 'quarantine_and_report')),
    CONSTRAINT vision_image_reviews_engine CHECK (engine IN ('text', 'ai', 'text+ai')),
    CONSTRAINT vision_image_reviews_status CHECK (status IN ('auto', 'decided')),
    CONSTRAINT vision_image_reviews_sha CHECK (image_sha256 IS NULL OR image_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT vision_image_reviews_mime CHECK (image_mime IS NULL OR image_mime ~ '^image/[a-z0-9.+-]+$'),
    CONSTRAINT vision_image_reviews_bytes CHECK (image_bytes IS NULL OR (image_bytes BETWEEN 1 AND 20971520)),
    CONSTRAINT vision_image_reviews_confidence CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    CONSTRAINT vision_image_reviews_cost CHECK (cost_usd >= 0),
    CONSTRAINT vision_image_reviews_latency CHECK (latency_ms >= 0),
    CONSTRAINT vision_image_reviews_preview CHECK (preview_url IS NULL OR preview_url ~ '^https?://')
);
CREATE INDEX vision_image_reviews_recent ON vision_image_reviews (created_at DESC);
CREATE INDEX vision_image_reviews_by_category ON vision_image_reviews (category, created_at DESC);
CREATE INDEX vision_image_reviews_by_owner ON vision_image_reviews (owner_subject, created_at DESC);
CREATE INDEX vision_image_reviews_by_object ON vision_image_reviews (object_type, object_id, created_at DESC);
CREATE INDEX vision_image_reviews_by_sha ON vision_image_reviews (image_sha256, created_at DESC);

-- The operator's record: one per category-3 review (a UNIQUE review_id makes a retry harmless). It is
-- internal; resolving it is the operator's action, and nothing is reported externally by this service.
CREATE TABLE vision_operator_reports (
    id            text COLLATE "C" PRIMARY KEY,               -- vor_ + ULID
    review_id     text COLLATE "C" NOT NULL UNIQUE REFERENCES vision_image_reviews (id) ON DELETE CASCADE,
    category      text COLLATE "C" NOT NULL DEFAULT 'minor_sexual',
    object_type   text COLLATE "C" NOT NULL DEFAULT 'unknown',
    object_id     text COLLATE "C",
    owner_subject text COLLATE "C",
    reason        text,
    status        text COLLATE "C" NOT NULL DEFAULT 'open',
    created_at    timestamptz NOT NULL DEFAULT now(),
    resolved_at   timestamptz,
    resolved_by   text COLLATE "C",
    CONSTRAINT vision_operator_reports_id CHECK (id ~ '^vor_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT vision_operator_reports_category CHECK (category IN ('minor_sexual')),
    CONSTRAINT vision_operator_reports_status CHECK (status IN ('open', 'resolved', 'dismissed')),
    CONSTRAINT vision_operator_reports_owner CHECK (owner_subject IS NULL OR owner_subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT vision_operator_reports_object_type CHECK (length(object_type) BETWEEN 1 AND 80),
    CONSTRAINT vision_operator_reports_object_id CHECK (object_id IS NULL OR length(object_id) <= 300)
);
CREATE INDEX vision_operator_reports_open ON vision_operator_reports (status, created_at DESC);
