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

## No faces

Vision never identifies or recognises faces, never names a person, and never describes a person's looks in public AI text. The model prompt
carries the rule and every AI answer is passed through `noLooks`; an answer that names looks is replaced. A report
that either rule was broken is a security report for this repository.

## Supported versions

Only the current `main` branch, which is what runs in production, receives fixes.
