-- phase: expand
-- OpenVibe.Vision v1: ask a picture, compare engines side by side, OCR with the local reader, and the UI check.
-- An answer and a UI check are a person's or a caller's own row, not the network's public record: v1 has no public
-- objects, so there is no Search outbox and no tombstone. No image bytes are ever stored: only a sha256 and the
-- declared media type. A model, provider, route and cost are recorded because every answer must say which model
-- answered and why.

CREATE TABLE vision_answers (
    id            text COLLATE "C" PRIMARY KEY,              -- vis_ + 26 Crockford base32 characters (ULID)
    subject       text COLLATE "C",                           -- usr_… for a person; null for a service caller
    requester     text COLLATE "C" NOT NULL,                  -- user:usr_… | service:design | anonymous
    task          text COLLATE "C" NOT NULL,                  -- ask | describe | ocr | compare
    question      text,
    mode          text COLLATE "C" NOT NULL DEFAULT 'auto',    -- auto | local | ai
    source        text COLLATE "C" NOT NULL,                  -- upload | url | data
    source_url    text,                                       -- the public URL a caller named, never a secret
    image_sha256  text COLLATE "C" NOT NULL,
    image_mime    text COLLATE "C" NOT NULL,
    image_bytes   integer NOT NULL,
    text          text,                                       -- the AI answer, stored as written
    answer        jsonb NOT NULL DEFAULT '{}'::jsonb,         -- model details, OCR lines, compare rows
    model         text COLLATE "C",
    provider      text COLLATE "C",
    route         text COLLATE "C",
    reason        text,                                       -- why this engine/model was chosen
    cost_usd      numeric(12, 6) NOT NULL DEFAULT 0,
    latency_ms    integer NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT vision_answers_id CHECK (id ~ '^vis_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT vision_answers_subject CHECK (subject IS NULL OR subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT vision_answers_requester CHECK (length(requester) BETWEEN 1 AND 160),
    CONSTRAINT vision_answers_task CHECK (task IN ('ask', 'describe', 'ocr', 'compare')),
    CONSTRAINT vision_answers_mode CHECK (mode IN ('auto', 'local', 'ai')),
    CONSTRAINT vision_answers_source CHECK (source IN ('upload', 'url', 'data')),
    CONSTRAINT vision_answers_sha CHECK (image_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT vision_answers_mime CHECK (image_mime ~ '^image/[a-z0-9.+-]+$'),
    CONSTRAINT vision_answers_bytes CHECK (image_bytes BETWEEN 1 AND 20971520),
    CONSTRAINT vision_answers_question CHECK (question IS NULL OR length(question) <= 2000),
    CONSTRAINT vision_answers_text CHECK (text IS NULL OR length(text) <= 20000),
    CONSTRAINT vision_answers_cost CHECK (cost_usd >= 0),
    CONSTRAINT vision_answers_latency CHECK (latency_ms >= 0)
);
CREATE INDEX vision_answers_by_subject ON vision_answers (subject, created_at DESC);
CREATE INDEX vision_answers_by_requester ON vision_answers (requester, created_at DESC);
CREATE INDEX vision_answers_by_hash ON vision_answers (image_sha256, created_at DESC);

-- One row per engine in a side-by-side compare: local Tesseract and/or one AI run per requested model. The
-- requested model is what the caller asked for; model/provider are what OpenVibe.AI's provenance says answered,
-- so a fallback is never mislabelled. These rows feed GET /api/v1/benchmarks (aggregate, no subjects).
CREATE TABLE vision_compare_samples (
    id               text COLLATE "C" PRIMARY KEY,            -- vcm_ + ULID
    answer_id        text COLLATE "C" REFERENCES vision_answers (id) ON DELETE CASCADE,
    subject          text COLLATE "C",
    task             text COLLATE "C" NOT NULL DEFAULT 'ask',
    engine           text COLLATE "C" NOT NULL,               -- local | ai
    requested_model  text COLLATE "C",
    model            text COLLATE "C",
    provider         text COLLATE "C",
    route            text COLLATE "C",
    ok               boolean NOT NULL DEFAULT false,
    text             text,
    cost_usd         numeric(12, 6) NOT NULL DEFAULT 0,
    latency_ms       integer NOT NULL DEFAULT 0,
    error_code       text COLLATE "C",
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT vision_compare_samples_id CHECK (id ~ '^vcm_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT vision_compare_samples_subject CHECK (subject IS NULL OR subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT vision_compare_samples_task CHECK (task IN ('ask', 'describe', 'ocr', 'translate', 'identify', 'count')),
    CONSTRAINT vision_compare_samples_engine CHECK (engine IN ('local', 'ai')),
    CONSTRAINT vision_compare_samples_cost CHECK (cost_usd >= 0),
    CONSTRAINT vision_compare_samples_latency CHECK (latency_ms >= 0)
);
CREATE INDEX vision_compare_samples_recent ON vision_compare_samples (created_at DESC);
CREATE INDEX vision_compare_samples_by_model ON vision_compare_samples (provider, model, created_at DESC);
CREATE INDEX vision_compare_samples_by_subject ON vision_compare_samples (subject, created_at DESC);

-- The UI check: a static layout pass over HTML/URL or a screenshot pass through OCR boxes and pixel sampling.
-- Findings are data (kind, severity, selector, detail, evidence); no screenshot is stored.
CREATE TABLE vision_ui_checks (
    id            text COLLATE "C" PRIMARY KEY,              -- vuc_ + ULID
    subject       text COLLATE "C",
    requester     text COLLATE "C" NOT NULL,
    source        text COLLATE "C" NOT NULL,                  -- html | url | screenshot
    url           text,
    image_sha256  text COLLATE "C",
    viewport_w    integer NOT NULL DEFAULT 1280,
    viewport_h    integer NOT NULL DEFAULT 800,
    engine        text COLLATE "C" NOT NULL,                  -- static-html | screenshot
    findings      jsonb NOT NULL DEFAULT '[]'::jsonb,
    summary       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT vision_ui_checks_id CHECK (id ~ '^vuc_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT vision_ui_checks_subject CHECK (subject IS NULL OR subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT vision_ui_checks_source CHECK (source IN ('html', 'url', 'screenshot')),
    CONSTRAINT vision_ui_checks_engine CHECK (engine IN ('static-html', 'screenshot')),
    CONSTRAINT vision_ui_checks_viewport CHECK (viewport_w BETWEEN 160 AND 10000 AND viewport_h BETWEEN 160 AND 10000),
    CONSTRAINT vision_ui_checks_sha CHECK (image_sha256 IS NULL OR image_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT vision_ui_checks_url CHECK (url IS NULL OR url ~ '^https?://')
);
CREATE INDEX vision_ui_checks_by_subject ON vision_ui_checks (subject, created_at DESC);

-- openvibe-sdk/account-data keeps its own idempotency here (ADR-033): a redelivered export or deletion changes
-- nothing. It holds an export_id or deletion_id, the subject and the counts sent to Network; it is not a secret.
CREATE TABLE account_data_events (
    id         text PRIMARY KEY,
    kind       text NOT NULL,
    subject    text NOT NULL,
    outcome    jsonb,
    applied_at timestamptz NOT NULL DEFAULT now(),
    sent_at    timestamptz
);

-- Request telemetry (openvibe-sdk/telemetry): one row per aggregated sample, pruned after 14 days.
CREATE TABLE telemetry_samples (
    id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at                    timestamptz NOT NULL,
    service               text NOT NULL,
    project               text,
    subject               text,
    resource              text,
    provider              text,
    node                  text,
    cell                  text,
    region                text,
    operation             text NOT NULL,
    latency_ms            double precision,
    queue_delay_ms        double precision,
    ttfb_ms               double precision,
    throughput_per_second double precision,
    bytes                 bigint,
    status                text,
    cache_status          text,
    cost_estimate         double precision,
    route_epoch           bigint,
    trace_id              text,
    extra                 jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX telemetry_samples_at_idx ON telemetry_samples (at);
CREATE INDEX telemetry_samples_service_idx ON telemetry_samples (service, operation, at);
