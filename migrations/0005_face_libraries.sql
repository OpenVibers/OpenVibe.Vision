-- phase: expand
-- F1: familiar faces for a camera owner's own cameras (plan L24, 2026-10-31).
--
-- A library belongs to one person (the camera owner) and the cameras they name. Only that subject's templates are
-- ever compared inside it: an unknown face is never looked up in another library, the platform or the web. The
-- region mode comes from the camera's own setting; strict means the named person's consent is checked before a
-- template exists. Templates stay AES-GCM ciphertext with the existing Vision key, and crops are ciphertext too.
--
-- The existing face_templates keeps its purpose rows. A familiar-face template is a row with feature='library'
-- whose scope is the face_library_people id, so the (subject, feature, scope) key still holds one template per
-- named person. library_id is the new column the plan asks for.

CREATE TABLE face_libraries (
    id          text COLLATE "C" PRIMARY KEY,             -- flb_ + ULID
    owner       text COLLATE "C" NOT NULL,                -- usr_…
    camera_ids  jsonb NOT NULL DEFAULT '[]'::jsonb,       -- Cam camera ids (cam_…); an owner may use one library for several
    region      text COLLATE "C" NOT NULL DEFAULT 'unknown',
    region_mode text COLLATE "C" NOT NULL DEFAULT 'strict' CHECK (region_mode IN ('strict', 'open')),
    threshold   double precision NOT NULL DEFAULT 0.363,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT face_libraries_id CHECK (id ~ '^flb_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT face_libraries_owner CHECK (owner ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT face_libraries_cameras CHECK (jsonb_typeof(camera_ids) = 'array'),
    CONSTRAINT face_libraries_region CHECK (length(region) BETWEEN 1 AND 40),
    CONSTRAINT face_libraries_threshold CHECK (threshold >= 0 AND threshold <= 1)
);
CREATE INDEX face_libraries_by_owner ON face_libraries (owner, created_at DESC);

-- One name in one library. A named person may be a Network subject (consent is checked in the registry) or only a
-- name the owner gave, in which case the link request is the consent. Until consent, status is pending_consent and
-- there is no template; the crop is kept encrypted only so the template can be made after the person accepts.
CREATE TABLE face_library_people (
    id             text COLLATE "C" PRIMARY KEY,           -- flp_ + ULID
    library_id     text COLLATE "C" NOT NULL REFERENCES face_libraries (id) ON DELETE CASCADE,
    owner          text COLLATE "C" NOT NULL,
    name           text COLLATE "C" NOT NULL,
    subject        text COLLATE "C",                       -- usr_… when the owner named an account
    status         text COLLATE "C" NOT NULL DEFAULT 'pending_consent'
                   CHECK (status IN ('active', 'pending_consent', 'denied')),
    consent_basis  text COLLATE "C" CHECK (consent_basis IN ('network', 'request')),
    muted          boolean NOT NULL DEFAULT false,         -- a muted name is still matched; its alerts are held
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    last_matched_at timestamptz,
    CONSTRAINT face_library_people_id CHECK (id ~ '^flp_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT face_library_people_owner CHECK (owner ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT face_library_people_subject CHECK (subject IS NULL OR subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT face_library_people_name CHECK (length(name) BETWEEN 1 AND 80)
);
CREATE UNIQUE INDEX face_library_people_name ON face_library_people (library_id, lower(name)) WHERE status <> 'denied';
CREATE INDEX face_library_people_library ON face_library_people (library_id, created_at DESC);
CREATE INDEX face_library_people_pending ON face_library_people (status, subject) WHERE status = 'pending_consent';

-- The crop the camera saw. Ciphertext only, exactly like face_media. Deleting the name deletes its crops at once.
CREATE TABLE face_library_crops (
    id                text COLLATE "C" PRIMARY KEY,       -- flc_ + ULID
    library_id        text COLLATE "C" NOT NULL REFERENCES face_libraries (id) ON DELETE CASCADE,
    person_id         text COLLATE "C" NOT NULL REFERENCES face_library_people (id) ON DELETE CASCADE,
    owner             text COLLATE "C" NOT NULL,
    kind              text COLLATE "C" NOT NULL DEFAULT 'enrol' CHECK (kind IN ('enrol', 'pending')),
    image_ciphertext  text NOT NULL,
    image_mime        text NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT face_library_crops_id CHECK (id ~ '^flc_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT face_library_crops_owner CHECK (owner ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT face_library_crops_mime CHECK (image_mime IN ('image/jpeg', 'image/png', 'image/webp'))
);
CREATE INDEX face_library_crops_by_person ON face_library_crops (person_id, created_at DESC);

-- A consent request. The raw token is returned once to the owner (the link they send) and only its sha256 is stored.
-- A person who already has a Network account also gets a Network notification through the registry.
CREATE TABLE face_consent_requests (
    id           text COLLATE "C" PRIMARY KEY,             -- fcr_ + ULID
    library_id   text COLLATE "C" NOT NULL REFERENCES face_libraries (id) ON DELETE CASCADE,
    person_id    text COLLATE "C" NOT NULL REFERENCES face_library_people (id) ON DELETE CASCADE,
    owner        text COLLATE "C" NOT NULL,
    subject      text COLLATE "C",
    token_hash   text COLLATE "C" NOT NULL UNIQUE,
    status       text COLLATE "C" NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'accepted', 'denied', 'expired')),
    text_version text COLLATE "C" NOT NULL,
    requested_at timestamptz NOT NULL DEFAULT now(),
    decided_at   timestamptz,
    expires_at   timestamptz NOT NULL,
    CONSTRAINT face_consent_requests_id CHECK (id ~ '^fcr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT face_consent_requests_owner CHECK (owner ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT face_consent_requests_subject CHECK (subject IS NULL OR subject ~ '^usr_[0-9A-HJKMNP-TV-Z]{26}$'),
    CONSTRAINT face_consent_requests_token CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT face_consent_requests_expiry CHECK (expires_at > requested_at)
);
CREATE INDEX face_consent_requests_pending ON face_consent_requests (person_id, requested_at DESC) WHERE status = 'pending';

-- The library templates live in the existing table. Add its column and one-template-per-name index.
ALTER TABLE face_templates ADD COLUMN library_id text COLLATE "C";
ALTER TABLE face_templates
    ADD CONSTRAINT face_templates_library_fk FOREIGN KEY (library_id) REFERENCES face_libraries (id) ON DELETE CASCADE;
CREATE INDEX face_templates_by_library ON face_templates (library_id, last_used_at DESC) WHERE library_id IS NOT NULL;
CREATE UNIQUE INDEX face_templates_one_per_person ON face_templates (library_id, scope) WHERE library_id IS NOT NULL;
