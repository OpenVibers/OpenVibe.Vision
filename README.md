# OpenVibe.Vision

> See with the best model for the job.

**Status:** v1 written and tested (see [STATUS.json](STATUS.json)).
**Domain:** `openvibe.vision` · **Port:** 5130 · **Service id:** `vision` · **Env prefix:** `VISION`
**License:** AGPL-3.0-only (same as every OpenVibe service).

OpenVibe.Vision answers questions about a picture. The cheapest engine goes first: the local Tesseract reader
answers a read question for nothing; otherwise OpenVibe.AI's routed vision model answers. The same image can be run
through the local reader and up to three AI model hints side by side, with the model that actually answered, its
cost and its measured latency. The UI check reads HTML, a public URL or a screenshot on this host and returns
overflow, cut-off text, low contrast, overlap and layering faults as JSON. **No face recognition, ever.**

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
- **No faces, no looks.** No face recognition is implemented or called; the prompt also forbids naming or identifying a person. Public AI text is passed through `noLooks`;
  an answer that names a person's looks is replaced by a neutral sentence.
- **Privacy.** No image bytes are stored: a sha256, media type and byte count are. Answers, compare samples and UI
  checks are exported and erased with the person's account.
- **Not in v1.** Public Arena leaderboards, video, computer-use benchmarks and OpenCV jobs on Run (v2/v3). v1 has no
  public records, so it writes no Search document and has no outbox.

## What runs where

| Step | Where | Cost | Leaves the host? |
|---|---|---|---|
| Image decode, rotate, resize, sha256 | this host, `sharp` | 0 | no |
| OCR | this host, Tesseract 5 (`OMP_THREAD_LIMIT=1`) | 0 | no |
| UI check (HTML/URL) | this host, static parser + WCAG maths | 0 | the URL fetch only (public HTTP) |
| UI check (screenshot) | this host, OCR boxes + `sharp` pixels | 0 | no |
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

No table stores image bytes, a token or a provider key.

## Does not own

- **Models, routing, quotas and provider keys** — OpenVibe.AI. Vision makes first-party `ai.run.create` runs with
  namespace `ai.*`; AI decides the provider/model and reports the provenance.
- **Identity, roles and accounts** — OpenVibe.Network. Vision verifies session and service tokens against its JWKS.
- **The local OCR binary and language data** — the host (Tesseract under `/usr/bin` and `/usr/share`).
- **Search** — OpenVibe.Search. v1 has no public records to index.
- **Events, the host and the database** — OpenVibe.Events, OpenVibe.Host.

## Capabilities and grants

The service offers four capabilities. The main session registers their manifests and grants them; v1 checks the
grant list directly, so a token that already carries one works.

| Capability | Routes | Typical caller |
|---|---|---|
| `vision.ask` | `POST /api/v1/ask`, `GET /api/v1/answers/:id` | a first-party service or a person |
| `vision.ocr` | `POST /api/v1/ocr` (the AI fallback also needs a person or this grant) | a first-party service or a person |
| `vision.compare` | `POST /api/v1/compare` | a first-party service or a person |
| `vision.ui.check` | `POST /api/v1/ui-check`, `GET /api/v1/ui-checks/:id` | **OpenVibe.Design's Arena**, or a person |

Outgoing: **`ai.run.create`** to OpenVibe.AI (audience `openvibe.ai`, namespace `ai.*`), minted by Network for the
client `vision`. No new AI capability, no provider key, no direct paid provider.

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
| `GET /api/v1/answers/:id` | one saved answer: its owner, or a service holding `vision.ask`. |
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
`vision.ocr_unavailable`, `vision.ai_unavailable`, `vision.not_found`, `vision.rate_limited`.

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
export/deletion and the image SSRF guard.

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
| Pics, Media, Chat → `POST /api/v1/alt` | `vision.alt` | Routed VLM through OpenVibe.AI; short editable `alt_text`; noLooks in the prompt and output. |
| Media, Search → `POST /api/v1/index`, `GET /api/v1/find?q=`, `POST /api/v1/find` | `vision.find` | Owner's verified user token; index `{item_id,image,result_url?}`; search by text or image. Owner is in every index read predicate. |
| Food → `POST /api/v1/receipt` | `vision.receipt` | Tesseract first; `fallback=true` permits routed VLM if local extraction is incomplete. |
| Deals → `POST /api/v1/product` | `vision.product` | CLIP vector and routed product description; `allow_rerank=true` permits another routed VLM call to rerank candidate offers. |
| Cam → `POST /api/v1/watch` | `vision.watch` | Owner's verified user token; upload still and `classes` array; optional `previous_image` data URL for scene change. |
| Live, Media → `POST /api/v1/moments` | `vision.moments` | Owner's verified user token; `{frames:[{timestamp_ms,image|image_url}],prompts?}`. Scene histogram and CLIP prompt matching. |

For private index, watch and moments, a service capability alone does not assert a source owner's grant. The room should call with the owner's delegated Network user token. Private index and watch reject `image_url`; the owner must supply bytes or a data URL. Moments accepts public frame URLs under Vision's existing guarded image fetch, or frame data URLs. The room that opens a returned `result_url` must check its own source grant again.

`npm run models:fetch` is an explicit, revision-pinned download into `${DATA_DIR:-data}/models`. It fetches quantized ONNX CLIP ViT-B/32 (`Xenova/clip-vit-base-patch32`, derived from OpenAI CLIP) and DETR ResNet-50 (`Xenova/detr-resnet-50`, derived from Facebook DETR). The local model loader never downloads weights during a request. Missing weights return 503 for model-dependent operations; histogram-only scene change remains available. CLIP code and model are listed as MIT, but the original checkpoint's weight licence has an [open clarification request](https://huggingface.co/openai/clip-vit-base-patch32/discussions/72); confirm this before commercial distribution. DETR model and weights are [Apache 2.0](https://huggingface.co/facebook/detr-resnet-50). We use DETR rather than Ultralytics (AGPL) or RF-DETR Nano because a supported local Transformers.js ONNX export exists for DETR. `@huggingface/transformers` is Apache 2.0. Tesseract is Apache 2.0.

Private embeddings are JSON vectors in PostgreSQL, scored in JavaScript after a mandatory `owner` filter. Vision has no pgvector migration or extension requirement. The v1 search cap is 5,000 items per owner.

Offer discovery is configured by `VISION_DEALS_SEARCH_URL` and `VISION_SHOES_SEARCH_URL`, both fixed operator URLs returning JSON `{offers:[{title,url,price?}]}` or `{results:[...]}`. Deals currently exposes public `GET /api/v1/offers` without a query filter, and its `/search?q=` is an HTML page; open.shoes has no implemented API in this workspace yet. Until those rooms expose a structured search endpoint, `/product` returns the description and embedding with an empty `offers` list and a warning. It does not fabricate matches.
