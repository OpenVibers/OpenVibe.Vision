# AGENTS.md — OpenVibe.Vision

## Project overview

OpenVibe.Vision (`https://openvibe.vision`) answers questions about pictures and pages: ask/describe/
identify/count/translate, OCR with a local Tesseract first, side-by-side model comparison, UI checks
(HTML, public URL or screenshot), a consented face library, and the network's read-only MCP tools.

- **Entry:** `server/index.js`; app `server/app.js`; port `5130`, service id `vision`.
- **API/pages:** `server/http/` — `api.js` (`/api/v1`), `faces-api.js`, `mcp.js`, `principal.js`,
  `pages.js`, `discovery.js`; views `server/views/index.js`, `people.js`, `review.js`, `tools.js`;
  rendering `server/render/`; own browser script `public/js/upload-picker.js`, CSS/img in `public/`.
- **Engine:** `server/vision/` — `service.js`, `images.js` (normalise/limits), `ocr.js` (Tesseract 5,
  `OMP_THREAD_LIMIT=1`), `ui-check.js` (static parser + WCAG maths + screenshot OCR/sharp), `ai.js`
  (`ai.run.create`), `network-tools.js`, `review.js`, `media-view.js`, `local-models.js`.
- **Faces:** `server/vision/faces.js`, `faces-model.js` (YuNet + SFace + ONNX Runtime),
  `face-libraries.js`, `consent-registry.js`; consent and encrypted vectors in the `face_*` tables.
- **Events:** `server/events/` (outbox, publisher) and `server/identity/account-data.js`.
- **Docs:** `README.md` ("Faces with consent", "Unsafe-image review", "MCP and events"), `SECURITY.md`.

## Owns, does not own

Owns its tables: `vision_answers` (`vis_`; task, question, source, image sha256/mime/bytes, cleaned
text, answer jsonb, model/provider/route, cost, latency), `vision_compare_samples` (`vcm_`),
`vision_ui_checks` (`vuc_`), `account_data_events`, `telemetry_samples`, and the face tables —
`face_consents`, `face_templates`, `face_media`, `face_tags`, `face_clusters` — plus `event_outbox`.
General answer tables store no image bytes, token or provider key; opt-in face media and vectors are
AES-GCM encrypted.

Does not own: models, routing, quotas and provider keys (AI — Vision makes first-party `ai.run.create`
runs and AI decides/reports the model and provenance); identity/roles (Network); the local OCR binary
and language data (the host: Tesseract under `/usr/bin`, `/usr/share`); Search (nothing public to
index); Events/Host/database. **Vision holds no provider key and calls no paid provider directly.**

## Who calls it, what it calls

People use the pages/API (session cookie or Network user Bearer; a session write must come from
`https://openvibe.vision`, else `403 vision.cross_site`); services use a token with the route's
capability (`vision.image.ask`, `vision.text.read`, `vision.model.compare`, `vision.ui.check`,
`vision.face.cast.match`, `vision.alt.write`). Typical callers: Design's Arena for UI checks, Live for
consented cast matching, Pics/Media/Chat for alt text. SDK `openvibe-sdk/vision` is the client surface
and `/mcp` exposes the read-only tools. Vision calls Network (JWKS) and AI (`ai.run.create`); the only
egress is AI plus an explicitly supplied public URL for a UI check, through the guard.

## Database and migrations

PostgreSQL through `openvibe-sdk/db` (PgBouncer for the app, owner role for migrations): `0001`
answers/compare/UI checks, `0003` the face tables, `0004` the event outbox; `0002`/later add the rest.
Applied at boot; never edit a migration that has run. `face_templates`, `face_media` and
`face_clusters` hold ciphertext, never a plaintext vector; `face_tags` disappear when a cast
revocation lands. Account export/deletion covers every table with a person column; a redelivery
changes nothing.

## Consent and privacy

Faces are opt-in and **purpose- and scope-scoped**: a `face_consents` row names the feature
(`verify|find|cast|library`), the channel/scope, the signed text version/name and an optional
`purpose_ends_at`; revoked consent stops detection/matching/tagging. Identifying matches require
separate consent; faces are detected, blurred and matched locally — no face image or vector goes to
AI. An unsafe-image review exists (`server/vision/review.js`); do not bypass it for a faster answer.
`/internal/events` is signed and loopback-only.

## Deploy

`deploy/systemd/openvibe-vision.service` (`127.0.0.1:5130`, env `/etc/openvibe/vision.env`) and
`deploy/nginx/openvibe.vision.conf` (TLS, www → apex, `/auth/me` on the API zone, a forms zone for
`/ask`, `/ocr`, `/compare`, `/ui-check`, `/internal` and `/metrics` 404). `sudo ovhost deploy vision`
is the production path; rollback with `sudo ovhost rollback vision --to <sha>`.

## Commands and tests

```bash
npm ci
npm run dev                  # http://127.0.0.1:5130
npm test                     # every test/*.test.js, PGlite + mock Network/AI
npm test -- ocr ui           # only matching files
npm run test:pg              # the same on PostgreSQL
npm run proof                # the v1 proof run
npm run models:faces         # download the YuNet/SFace models on the host
npm run models:fetch         # fetch the local model set
```

`test/run.js` uses `openvibe-shared/test-runner` (90 s, serial); temp PGlite, a mock Network and AI
and local image/page fixtures, never the network. Coverage includes OCR/local-first and fallback,
compare/benchmarks, UI checks, faces/consent, libraries, network tools/MCP, unsafe-image review,
events/outbox, account data and the pages. Some model/OCR work skips without the binaries — a skipped
file is never counted as passed.

## Conventions and pitfalls

- CommonJS, 4-space indent, single quotes, semicolons; problem+json with a stable code; escaped HTML.
- **Local first, AI second, never a direct provider:** Tesseract answers a read for free; AI's routed
  model is the only paid path and `requested_model` is a hint, not a promise. Report the model/provider/
  route that AI says answered, with cost and latency.
- **No image bytes in the answer tables**, and no token/provider key anywhere in the repo. The
  normalised image is what goes to AI, not the original.
- **Consent is checked per feature and scope, on every use**, and revoked/expired means no match; an
  identifying match needs its own purpose. Never use a face vector outside the encrypted store.
- **The unsafe-image review is a gate**, not a suggestion; a route that returns image text or alt text
  must run it.
- **A UI check of a URL only fetches a public HTTP(S) address** through the guard; never loopback,
  private ranges or a redirect that lands there.
- **Alt text is written as text**, never markup; a caller's content is untrusted.
