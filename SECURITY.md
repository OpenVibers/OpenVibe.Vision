# Security policy

OpenVibe is run in the open, and we want to hear about security problems before anyone else does.

## Reporting a vulnerability

Email **contact@openvibe.network** with "security" in the subject. Please include what you found, where (URL,
repository, file), how to reproduce it, and what an attacker could do with it. Do not open a public GitHub issue for
a vulnerability, and do not test against other people's accounts, data or streams.

We reply within 7 days, keep you updated while we fix it, and credit you when the fix ships if you would like.

## Scope

Every OpenVibe service and site (openvibe.live, openvibe.network, openvibe.vision, openvibe.design, openvibe.meme,
openvibe.today, openvibe.tools, openvibe.media, openvibe.community, openvibe.games and the other openvibe.*
domains) and every repository under github.com/OpenVibers. Machine-readable contact details are at
`/.well-known/security.txt` on each site.

## What OpenVibe.Vision holds

- Saved answers: the question, the cleaned answer text, the engine/model/provider/route that answered, the reason,
  the cost, the latency, the image sha256, the media type and the byte count. Never the image bytes.
- Compare samples: the same model/provenance/cost/latency per engine. Aggregate benchmark rows have no subject.
- UI checks: source (html, url or screenshot), the viewport, the findings and the summary. Never the screenshot.
- A person's Network session tokens only in httpOnly cookies (`vision_at`, `vision_rt`); no token is stored in the
  database, rendered into a page or logged.
- Face data, only after a separate consent: AES-256-GCM ciphertext of face templates, opt-in Vision uploads and
  vectors; the signed consent record (typed name, text version and time), cast tags and private library groups.
  Never sent to OpenVibe.AI, Search, model prompts or Bench.
- No provider key. AI calls use the service's own Network client-credentials token and OpenVibe.AI's routing.

## Image inputs and the UI check

An image URL is fetched only after every resolved address is checked: loopback, link-local, private and
unique-local addresses are refused, redirects are re-checked, the content type must be an image and the size is
bounded. `VISION_ALLOW_PRIVATE_URLS=1` exists for tests and a deliberately isolated deployment; it is off in
production. A UI check URL goes through the same public-address guard, executes no JavaScript and fetches no remote
stylesheet. The screenshot path writes a temporary file for Tesseract and removes it in a finally block.

The `/internal/events` account route is loopback only and refuses a proxied request; nginx answers 404 for
`/internal` and `/metrics`. A service token is judged on its own signature, audience and capability grant; an
unknown or forged token is refused, never downgraded to the session.

## Faces with scoped consent

Detect and blur do not identify anyone. Face matching uses local YuNet/SFace ONNX models and separately signed, purpose-specific consent. Templates and opt-in uploads are encrypted with `VISION_FACE_KEY` (AES-256-GCM) and private; a person can withdraw a purpose and erase its template immediately. A cast matcher reads only the named channel's consenting roster, and revoking a grant stops matches and deletes past tags. Library grouping is off unless `VISION_FACE_LIBRARY_REGIONS` allows the region. Vision never identifies strangers on the open web, builds no public face index, and a match alone never unlocks anything (liveness is `not_checked` until a tested component exists). AI may describe people, including how they look; the model prompt forbids naming or recognising a stranger, and no looks filter runs. A report that any rule was broken is a security report for this repository.

## Supported versions

Only the current `main` branch, which is what runs in production, receives fixes.
