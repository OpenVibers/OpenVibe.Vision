# OpenVibe.Vision

> See with the best model for the job.

**Status:** v1, the §5.8b faces work and the network tools written and tested (see [STATUS.json](STATUS.json)).
**Domain:** `openvibe.vision` · **Port:** 5130 · **Service id:** `vision` · **Env prefix:** `VISION`
**License:** AGPL-3.0-only (same as every OpenVibe service).

OpenVibe.Vision answers questions about a picture. The cheapest engine goes first: the local Tesseract reader
answers a read question for nothing; otherwise OpenVibe.AI's routed vision model answers. The same image can be run
through the local reader and up to three AI model hints side by side, with the model that actually answered, its
cost and its measured latency. The UI check reads HTML, a public URL or a screenshot on this host and returns
overflow, cut-off text, low contrast, overlap and layering faults as JSON. Face tools run locally; identifying matches require separate, purpose-scoped consent.

## v1 scope (plan §5.8)

- **Ask a picture.** Describe, read, identify, count, translate. Upload a file, send a data URL, or paste a public
  image URL. Every answer reports the engine, model, provider, route, why it was chosen, the cost and the latency.
- **OCR with a local engine first.** Tesseract 5 runs on this host; no image leaves it and no model is called. An
  AI fallback is opt-in (`fallback=1`) and runs only when the local pass found no usable text.
- **Compare models side by side.** One image, the local reader and one to three AI model hints. AI's router is the
  authority: `requested_model` is only the hint, `model`/`provider` are what AI says answered. Each sample records
  cost and latency; `GET /api/v1/benchmarks` aggregates them with no subject or answer text.
- **The UI check as an API.** `POST /api/v1/ui-check` is what Design's Arena will call, with a service token holding
  `vision.ui.check`. It also works for a signed-in person and, for HTML/URL/screenshot, anonymously.
- **Consent-scoped faces, no looks in AI text.** Face detection and blur are open privacy tools. Matching requires a separate signed consent for each purpose. Public AI text is passed through `noLooks`;
  an answer that names a person's looks is replaced by a neutral sentence.
- **Privacy.** General answers store no image bytes: a sha256, media type and byte count are stored. Opt-in face uploads, vectors and templates are encrypted and private. Answers, compare samples, UI checks and every face row are exported and erased with the person's account.
- **Not in v1.** Public Arena leaderboards, video, computer-use benchmarks and OpenCV jobs on Run (v2/v3). v1 has no
  public records, so it writes no Search document and has no outbox.

## Faces with consent (§5.8b)

`npm run models:faces` downloads pinned OpenCV Zoo YuNet and SFace weights into `DATA_DIR/models`, checking a SHA-256 before installation. They are not in git. YuNet's directory is MIT licensed; SFace's directory is Apache 2.0 licensed. **Open question before production distribution:** [SFace weight and training-data provenance](https://github.com/opencv/opencv_zoo/issues/318) needs upstream clarification. The service starts without weights or `VISION_FACE_KEY`; `/api/ready` reports an optional degraded face check. Detect/blur need only YuNet; enrolment, verification and cast matching also need SFace and the key, and answer 503 until they exist. All face inference uses `onnxruntime-node` on this host, never a cloud model.

The key is `VISION_FACE_KEY` (base64 encoding of 32 random bytes). AES-256-GCM encrypts templates, Vision uploads and face vectors under the person's Network subject. Losing this key makes stored face data unreadable; rotate it only with a re-encryption migration. `VISION_FACE_MATCH_THRESHOLD` defaults to the OpenCV SFace cosine example threshold 0.363 and needs calibration before consequential use. `VISION_FACE_LIBRARY_REGIONS` is a comma-separated allowlist; empty disables library grouping everywhere. `VISION_FACE_PRIVACY_RATE_LIMIT_PER_MIN` limits anonymous detect/blur, alongside the API address limit. No face template enters Search, model prompts or Bench.

The four signed text versions are exposed by `GET /api/v1/faces/consents/text`. A Network person signs one purpose at a time by sending `signed_name` and the current `text_version` to `POST /api/v1/faces/consents/:feature` (`verify`, `find`, `cast`, `library`). Cast also needs `adult: true` and a named `channel`; library needs an allowed `region`. The signed name and server time are kept in `face_consents`. `DELETE /api/v1/faces/consents/:feature` revokes and immediately deletes that purpose's template; cast revocation also removes past tags. `/people` has the same choices and `/people/privacy` explains face retention. The site's shared legal privacy policy remains at `/privacy`.

| Route | Result and scope |
|---|---|
| `POST /api/v1/faces/detect`, `/blur` | Anyone; boxes/count or image/png redaction, no templates or tracking. |
| `POST /api/v1/faces/enrol/:feature` | Network person only; one face image after that feature's consent (`verify`, `find`, `cast`). |
| `POST /api/v1/faces/verify` | Person only; `{score,match,threshold,liveness:"not_checked"}` against their own verify template. A match alone must never unlock anything: use a tested liveness component, second factor and non-biometric route before any consequential use. |
| `POST /api/v1/faces/media`, `GET /api/v1/faces/media/:id`, `POST /api/v1/faces/find` | Person only; encrypted own Vision uploads, owner-only links and self-search matches. Media objects are deferred until a source-owner grant and open-time access check exist. |
| `POST /api/v1/faces/cast/match` | Live service token with `vision.face.cast.match` and signed `channel_id` claim; compares only that channel's enrolled roster. Requires on-stream notice from Live. Person can inspect their own tags at `GET /api/v1/faces/cast/tags`. |
| `POST /api/v1/faces/library/cluster`, `GET /api/v1/faces/library/groups`, `POST /api/v1/faces/library/correct` | Person only, separate opt-in and allowed region. Unknown groups have no label. Corrections: `exclude`, `merge`, `split`; switching off erases groups. |

`face_consents`, `face_templates`, `face_media`, `face_tags` and `face_clusters` are created by `migrations/0003_faces.sql`. A daily job (off in `VISION_DRILL`) deletes inactive templates at three years since last use and revoked consent audit rows within one year of purpose end. ADR-033 export and account deletion include all five tables. The account export carries encrypted template and upload ciphertext; it does not expose the server key.

## What runs where

| Step | Where | Cost | Leaves the host? |
|---|---|---|---|
| Image decode, rotate, resize, sha256 | this host, `sharp` | 0 | no |
| OCR | this host, Tesseract 5 (`OMP_THREAD_LIMIT=1`) | 0 | no |
| UI check (HTML/URL) | this host, static parser + WCAG maths | 0 | the URL fetch only (public HTTP) |
| UI check (screenshot) | this host, OCR boxes + `sharp` pixels | 0 | no |
| Face detect, blur and consented matching | this host, YuNet + SFace + ONNX Runtime | 0 | no |
| Ask / describe / identify / count / translate | OpenVibe.AI's routed vision model | AI's own accounting | the normalised image, to OpenVibe.AI |
| OCR AI fallback | OpenVibe.AI's routed vision model | AI's own accounting | only after an empty local pass and with consent |
| Compare | local + AI hints | local free; AI's own accounting | the normalised image, to OpenVibe.AI |

Vision holds no provider key, adds no provider and calls no paid provider directly. `ai.run.create` is the only
outbound capability; AI's quotas and its own route decide whether a run is allowed.

## Owns

| Table | Holds | Migration |
|---|---|---|
| `vision_answers` | `vis_` + ULID, subject (`usr_…` or null), requester, task `ask\|describe\|ocr\|compare`, question, mode, source, public `source_url`, image sha256/mime/bytes, cleaned `text`, `answer` jsonb (engine, reason, words, samples, run id), model/provider/route, cost, latency | `migrations/0001_initial.sql` |
| `vision_compare_samples` | `vcm_` + ULID, answer, subject, task, engine `local\|ai`, requested model, answered model/provider/route, ok, text, cost, latency, error code | `0001_initial.sql` |
| `vision_ui_checks` | `vuc_` + ULID, subject, requester, source `html\|url\|screenshot`, URL, image sha256, viewport, engine `static-html\|screenshot`, findings jsonb, summary jsonb | `0001_initial.sql` |
| `account_data_events` | openvibe-sdk/account-data's export/deletion receipts | `0001_initial.sql` |
| `telemetry_samples` | aggregated request telemetry, pruned after 14 days | `0001_initial.sql` |
| `face_consents` | subject, feature `verify\|find\|cast\|library`, channel scope, signed text version/name, granted_at, revoked_at, last_used_at, purpose_ends_at | `migrations/0003_faces.sql` |
| `face_templates` | subject, feature, scope, AES-GCM ciphertext of the SFace vector, created/last_used times | `0003_faces.sql` |
| `face_media` | owner, AES-GCM ciphertext of an opt-in Vision upload and its face vectors, media type | `0003_faces.sql` |
| `face_tags` | consenting subject, channel, private media reference and time; removed on cast revocation | `0003_faces.sql` |
| `face_clusters` | owner, media, encrypted vector, group id, optional label (null while unknown), excluded flag | `0003_faces.sql` |
| `event_outbox` | the events Vision publishes wait here until OpenVibe.Events takes them: the envelope, its own event id (the idempotency key), the attempts and the last error; sent rows are pruned after 7 days | `migrations/0004_event_outbox.sql` |

General answer tables store no image bytes, token or provider key. The opt-in face library stores encrypted uploads and vectors.

## Does not own

- **Models, routing, quotas and provider keys** — OpenVibe.AI. Vision makes first-party `ai.run.create` runs with
  namespace `ai.*`; AI decides the provider/model and reports the provenance.
- **Identity, roles and accounts** — OpenVibe.Network. Vision verifies session and service tokens against its JWKS.
- **The local OCR binary and language data** — the host (Tesseract under `/usr/bin` and `/usr/share`).
- **Search** — OpenVibe.Search. v1 has no public records to index.
- **Events, the host and the database** — OpenVibe.Events, OpenVibe.Host.

## Capabilities and grants

Contracts 0.240.0 registers twenty Vision capabilities. The service checks each machine token's grant on its route;
private media and face identity operations also require the verified owner or the person's purpose-scoped consent.

| Capability | Routes | Typical caller |
|---|---|---|
| `vision.image.ask` | `POST /api/v1/ask`, `GET /api/v1/answers/:id` | a first-party service or a person |
| `vision.text.read` | `POST /api/v1/ocr` (the AI fallback also needs a person or this grant) | a first-party service or a person |
| `vision.model.compare` | `POST /api/v1/compare` | a first-party service or a person |
| `vision.ui.check` | `POST /api/v1/ui-check`, `GET /api/v1/ui-checks/:id` | **OpenVibe.Design's Arena**, or a person |
| `vision.face.cast.match` | `POST /api/v1/faces/cast/match` (a signed `channel_id` claim must match the request) | **OpenVibe.Live**, or a person inspecting their own tags |
| `vision.alt.write` | `POST /api/v1/alt` | Pics, Media and Chat |
| `vision.media.find` | `POST /api/v1/index`, `GET`/`POST /api/v1/find` (owner user token) | Media and Search |
| `vision.receipt.read` | `POST /api/v1/receipt` | Food |
| `vision.product.match` | `POST /api/v1/product` | Deals |
| `vision.camera.watch` | `POST /api/v1/watch` (owner user token) | Cam |
| `vision.video.moments` | `POST /api/v1/moments` (owner user token) | Live and Media |
| `vision.face.detect`, `vision.face.blur` | `POST /api/v1/faces/detect`, `/blur` | Public privacy tools; a service token needs the matching grant |
| `vision.face.consent.manage`, `vision.face.verify.self`, `vision.face.find.self`, `vision.face.library`, `vision.face.cast.read` | `/api/v1/faces/*` | The person themselves, with separate signed consent for each matching purpose |
| `vision.models.read`, `vision.benchmarks.read` | `GET /api/v1/models`, `/benchmarks` | Public reads; a service token needs the matching grant |

Outgoing: **`ai.run.create`** to OpenVibe.AI (audience `openvibe.ai`, namespace `ai.*`), minted by Network for the
client `vision`. No new AI capability, no provider key, no direct paid provider.

## MCP and events

`POST /mcp` serves Streamable HTTP JSON-RPC 2.0 (`initialize`, `ping`, `tools/list`, `tools/call`).
`/.well-known/oauth-protected-resource` advertises its Network authorization server; a private tool without a
token responds with a `WWW-Authenticate` challenge pointing to that metadata. The tools are `vision.ask_image`,
`vision.read_text`, `vision.translate_sign`, `vision.find_similar`, `vision.search_my_media`,
`vision.describe_clip`, `vision.detect_objects`, `vision.blur_faces`, `vision.check_ui`,
`vision.compare_models` and `vision.get_job`. Face enrolment, verification, cast matching and consent mutation
are available only through their person or Live-specific API routes, never through MCP.

When configured with Events and a Network client secret, successful owner results publish `vision.result.ready`
with provenance, cost and retention, without image or answer text. A watch result with `source_ref` and detections
publishes `vision.alert` with classes and confidence. Publishing failures are logged without exposing payloads.

## API

JSON under `/api/v1`; errors are `application/problem+json` with a `code`. An image is a multipart `image` field, a
JSON `image` data URL, or a JSON `image_url` public URL. A person is the `vision_at` session cookie or a Network user
token as a Bearer. A session write must come from `https://openvibe.vision` (403 `vision.cross_site`). A service token
must hold the route's capability (403 `capability.denied`).

| Route | What it does |
|---|---|
| `POST /api/v1/ask` (alias `POST /api/v1/describe`) | `{ task?, question, mode?, lang?, model?, image_url? }` or multipart `image`; returns `{ answer }`. A read question is local-first, otherwise AI. |
| `POST /api/v1/ocr` | multipart/data URL/URL; `{ fallback?, lang?, model? }`; returns the OCR row with `text`, `answer.confidence`, `answer.words`, cost 0. |
| `POST /api/v1/compare` | `{ task?, question?, models?: string[] }` plus an image; returns `{ answer, compare }`, one row per engine. |
| `POST /api/v1/ui-check` | `{ html }`, `{ url }`, or a screenshot plus `{ viewport: { w, h } }`; returns `{ check }` with `findings`, `counts`, `severity`, `warnings`. |
| `GET /api/v1/answers/:id` | one saved answer: its owner, or a service holding `vision.image.ask`. |
| `GET /api/v1/ui-checks/:id` | one saved UI check: its owner, or a service holding `vision.ui.check`. |
| `GET /api/v1/models` | AI's offered `provider:model` hints and the local engine. No subject data. |
| `GET /api/v1/benchmarks?task=&limit=` | aggregate compare samples: task, engine, provider, model, samples, mean latency, mean cost. No subject or answer text. |
| `GET /api/v1/ping`, `/api/health`, `/api/ready`, `/release.json`, `/metrics` | service endpoints; readiness and metrics are truthful, metrics loopback-only. |

Example — the call Design's Arena makes:

```sh
curl -s -X POST https://openvibe.vision/api/v1/ui-check \
  -H "Authorization: Bearer $VISION_SERVICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"html":"<!doctype html><style>.card{width:1400px}</style><div class=card>x</div>","viewport":{"w":390,"h":844}}'
```

Answer (abridged):

```json
{ "check": {
  "engine": "static-html",
  "viewport": { "w": 390, "h": 844 },
  "counts": { "overflow": 1, "contrast": 1 },
  "severity": { "high": 1, "medium": 1 },
  "findings": [
    { "kind": "overflow", "severity": "medium", "selector": "div.card", "detail": "the box is 1400px wide and reaches 1400px in a 390px viewport", "evidence": { "width": 1400, "right": 1400, "viewport": 390 } }
  ]
}}
```

Validation refusals: `vision.invalid`, `vision.invalid_task`, `vision.invalid_mode`, `vision.question_required`,
`vision.image_required`, `vision.image_too_large`, `vision.image_private_url`, `vision.image_unsupported`,
`vision.text.read_unavailable`, `vision.ai_unavailable`, `vision.not_found`, `vision.rate_limited`, and the face codes
`faces.consent_required`, `faces.signature_required`, `faces.adult_required`, `faces.region_disabled`,
`faces.enrolment_required`, `faces.one_face_required`, `faces.model_unavailable`, `faces.key_unavailable`,
`faces.live_grant_required`.

## Pages

All server-rendered through the OpenVibe Frame (`openvibe-shared/shell`), readable without JavaScript, semantic HTML
with stable `vi-` ids/classes. Public pages are `public, max-age=60` with `Vary: Cookie`; a page drawn for a signed-in
person is `private, no-store`.

| Page | What it is |
|---|---|
| `/` | the room: hero, ask, compare and UI-check scenes, and a try section |
| `/ask` | upload or URL + a question (POST → `/a/:id`) |
| `/ocr` | local OCR, with an inline reading for a guest and a saved answer for a person |
| `/compare` | local OCR vs AI model hints (POST → `/a/:id`) |
| `/ui-check` | HTML, URL or screenshot; inline for a guest, saved at `/ui/:id` for a person |
| `/a/:id` | one saved answer (owner or staff) |
| `/ui/:id` | one saved UI check (owner or staff) |
| `/find` | private visual search over a person's own indexed images |
| `/read` | the receipt reader |
| `/watch` | watched objects and scene change in a camera still |
| `/people` | the four face purposes, each with its own signed switch, enrolment and off control |
| `/people/privacy` | the face notice: retention, erasure, liveness and what never happens |
| `/privacy` | the shared legal privacy policy |
| `/developers` | the API, capabilities and what leaves the host |
| 404 | the not-found page |

`public/css/vision.css` and `public/js/vision.js` are one-comment placeholder files: the pages work without them and
the main session designs them. `robots.txt`, `sitemap.xml`, `llms.txt` and `llms-full.txt` list only the public
pages; `/a/`, `/ui/`, `/auth/`, `/api/` and `/internal` are not indexed.

## The v1 proof

`node scripts/proof.js` is offline: it renders a receipt, reads it with local Tesseract, and checks a page with a
planted 1400 px overflow, a clipped nowrap line and low contrast. It exits non-zero if the local reader misses the
total or the UI check misses a fault. The tests do the same over the API, and `test/compare.test.js` runs two AI
hints and the local reader on one image with measured cost and latency.

## Run and test

```sh
npm install
npm test                    # PGlite; every file in its own process, no network needed
npm run test:pg             # the same through PostgreSQL + PgBouncer (openvibe-sdk scripts/test-services.sh up)
OV_ALLOW_SUITE=1 npm test
npm start                   # PORT 5130, loopback; DATABASE_URL or an embedded PGlite in development
node scripts/proof.js       # local OCR + a planted UI overflow, no network and no model
```

The tests use a mock Network, a mock OpenVibe.AI and local image/page fixtures: migration, SSO and readiness, the
API and its capability guards, local OCR and its fallback, compare and benchmark aggregation, the UI check (a
planted overflow, cut-off line, low contrast, overlap and layering fault), noLooks, pages/cache, account
export/deletion, the image SSRF guard, and faces with a fake ONNX model (all four consent gates, opt-out erasure,
cast-roster-only matching, AES-GCM at rest, the retention job, the region gate and ADR-033 export/deletion).

## Deploy

`deploy/systemd/openvibe-vision.service` (127.0.0.1:5130, `/etc/openvibe/vision.env`) and
`deploy/nginx/openvibe.vision.conf` (TLS, www → apex, `/auth/me` on the API zone, a forms zone for `/ask`, `/ocr`,
`/compare` and `/ui-check`, `/internal` and `/metrics` 404). Not deployed by this change.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).

## Network tools, wave 1

All six tools are JSON APIs. Successful `answer` objects carry a `receipt` with engine, model, `cost_usd`, `ms`, confidence and retention. An image is multipart `image` or JSON `image` data URL unless a route says otherwise. Vision does not retain image bytes.

| Room call | Capability | Notes |
|---|---|---|
| Pics, Media, Chat → `POST /api/v1/alt` | `vision.alt.write` | Routed VLM through OpenVibe.AI; short editable `alt_text`; noLooks in the prompt and output. |
| Media, Search → `POST /api/v1/index`, `GET /api/v1/find?q=`, `POST /api/v1/find` | `vision.media.find` | Owner's verified user token; index `{item_id,image,result_url?}`; search by text or image. Owner is in every index read predicate. |
| Food → `POST /api/v1/receipt` | `vision.receipt.read` | Tesseract first; `fallback=true` permits routed VLM if local extraction is incomplete. |
| Deals → `POST /api/v1/product` | `vision.product.match` | CLIP vector and routed product description; `allow_rerank=true` permits another routed VLM call to rerank candidate offers. |
| Cam → `POST /api/v1/watch` | `vision.camera.watch` | Owner's verified user token; upload still and `classes` array; optional `previous_image` data URL for scene change. |
| Live, Media → `POST /api/v1/moments` | `vision.video.moments` | Owner's verified user token; `{frames:[{timestamp_ms,image|image_url}],prompts?}`. Scene histogram and CLIP prompt matching. |

For private index, watch and moments, a service capability alone does not assert a source owner's grant. The room should call with the owner's delegated Network user token. Private index and watch reject `image_url`; the owner must supply bytes or a data URL. Moments accepts public frame URLs under Vision's existing guarded image fetch, or frame data URLs. The room that opens a returned `result_url` must check its own source grant again.

`npm run models:fetch` is an explicit, revision-pinned download into `${DATA_DIR:-data}/models`. It fetches quantized ONNX CLIP ViT-B/32 (`Xenova/clip-vit-base-patch32`, derived from OpenAI CLIP) and DETR ResNet-50 (`Xenova/detr-resnet-50`, derived from Facebook DETR). The local model loader never downloads weights during a request. Missing weights return 503 for model-dependent operations; histogram-only scene change remains available. CLIP code and model are listed as MIT, but the original checkpoint's weight licence has an [open clarification request](https://huggingface.co/openai/clip-vit-base-patch32/discussions/72); confirm this before commercial distribution. DETR model and weights are [Apache 2.0](https://huggingface.co/facebook/detr-resnet-50). We use DETR rather than Ultralytics (AGPL) or RF-DETR Nano because a supported local Transformers.js ONNX export exists for DETR. `@huggingface/transformers` is Apache 2.0. Tesseract is Apache 2.0.

Private embeddings are JSON vectors in PostgreSQL, scored in JavaScript after a mandatory `owner` filter. Vision has no pgvector migration or extension requirement. The v1 search cap is 5,000 items per owner.

Offer discovery is configured by `VISION_DEALS_SEARCH_URL` and `VISION_SHOES_SEARCH_URL`, both fixed operator URLs returning JSON `{offers:[{title,url,price?}]}` or `{results:[...]}`. Deals currently exposes public `GET /api/v1/offers` without a query filter, and its `/search?q=` is an HTML page; open.shoes has no implemented API in this workspace yet. Until those rooms expose a structured search endpoint, `/product` returns the description and embedding with an empty `offers` list and a warning. It does not fabricate matches.

<!-- versions:start -->
- openvibe-contracts: v0.240.0
- openvibe-sdk: v0.74.0
- openvibe-shared: v4.92.0
<!-- versions:end -->
