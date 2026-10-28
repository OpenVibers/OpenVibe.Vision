# Changelog

What changed in OpenVibe.Vision, newest first.

## 0.1.0 — 2026-10-28

The first version: see with the best model for the job.

- **Ask a picture.** `POST /api/v1/ask` takes a multipart image, an image data URL or a public `image_url`, plus a
  question and one of `ask|describe|identify|count|translate|ocr`. A read question is answered by the local OCR
  reader first; anything else goes through OpenVibe.AI. The answer names the engine, model, provider, route, reason,
  cost and measured latency.
- **Local OCR first.** `POST /api/v1/ocr` runs Tesseract 5 on this host (one OpenMP thread, a temporary file that is
  removed), returns the text, mean confidence and word boxes, and costs zero. `fallback=1` asks AI only when the
  local pass found no usable text; a missing binary is an honest 503, never a silent cloud call.
- **Compare side by side.** `POST /api/v1/compare` runs the local reader and up to three AI hints on the same image.
  The requested model is only a hint: the provider and model reported are AI's own provenance. Each row carries
  success, text, cost and latency; `GET /api/v1/benchmarks` aggregates them per engine/model without subjects.
- **The UI check.** `POST /api/v1/ui-check` reads HTML, a public page URL or a screenshot locally. The static pass
  estimates boxes and inline CSS to find overflow, cut-off text, WCAG contrast failures, overlapping positioned
  boxes and layering faults (`z-index` without position, a full-viewport fixed box). The screenshot pass uses the
  local OCR boxes and sharp pixels. Findings are data: kind, severity, selector, detail, evidence. Design's Arena
  calls it with `vision.ui_check`.
- **The AI gateway.** Vision calls OpenVibe.AI's OpenAI-compatible endpoint with a first-party service token
  (`ai.run.create`, namespace `ai.*`). AI's routing, quotas, cache, provenance and cost accounting apply. Vision holds
  no provider key, adds no provider and calls no paid provider directly.
- **No looks, no faces.** Public AI text goes through `noLooks`; an answer that names a person's looks is replaced by
  a neutral sentence. Face recognition is not implemented and is not called, ever.
- **Privacy.** No image bytes are stored: an answer keeps a sha256, the media type, the cleaned text and the model
  provenance. Answers, compare samples and UI checks are exported and erased with the person's account.
- **The service.** Network sign-in as OAuth client `vision` (PKCE S256, `vision_at`/`vision_rt`/`vision_oauth`),
  truthful readiness, Prometheus metrics on loopback, discovery, a systemd unit, an nginx vhost and CI. Pages are
  server-rendered with stable `vi-` ids/classes; `public/css/vision.css` and `public/js/vision.js` are
  one-comment placeholders for the main session.
- **Tests.** Migration, SSO, API, OCR, compare/benchmarks, the UI check (including a planted overflow), noLooks,
  pages/cache and account export/deletion, each in its own process on a temporary PGlite database with a mock
  Network, a mock OpenVibe.AI and local image/page fixtures.
