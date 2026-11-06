-- phase: expand
-- VIS-6 operator evidence views: when an operator presses "Show the picture" on a hidden or quarantined
-- review, Vision asks Media for a 60-second operator view and records who saw it and when. The row is
-- shown on the review page and stays with the operator report; it records no image and no signed URL.
CREATE TABLE vision_review_reveals (
    id                text COLLATE "C" PRIMARY KEY,            -- virv_ + ULID
    review_id         text COLLATE "C" NOT NULL REFERENCES vision_image_reviews (id) ON DELETE CASCADE,
    operator_subject  text COLLATE "C" NOT NULL,
    kind              text COLLATE "C" NOT NULL,
    expires_at        timestamptz,
    revealed_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT vision_review_reveals_id CHECK (id ~ '^virv_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT vision_review_reveals_operator CHECK (operator_subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT vision_review_reveals_kind CHECK (kind IN ('media_operator_view', 'preview'))
);
CREATE INDEX vision_review_reveals_by_review ON vision_review_reveals (review_id, revealed_at DESC);
