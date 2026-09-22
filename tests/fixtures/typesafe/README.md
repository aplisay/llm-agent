# TypeSafe Jev fixtures

Request and response bodies for the decision-model tests
(`tests/typesafe-model.test.mjs`, `tests/subagent-decision.test.mjs`,
`tests/typesafe-validation.test.mjs`).

Each file records its provenance in a `source` field:

- `schema` files follow the vendor's published OpenAPI document
  (`https://api.typesafe.ai/openapi.json`, version 0.2.0, read on
  2026-09-22) and its documented examples. They are hand-built, not
  recorded, and are to be replaced by recordings from the P0 spike
  (`aplisay-strategy/research/jev-spike-findings.md`) as soon as it has run.
- `recorded` files are verbatim bodies from a live exchange, with the date
  and route.

`six-questions.json` is the spec's default post-call question set against an
escalation transcript; `score-two-levels.json` and `score-ten-levels.json`
show the `legend` and `probabilities` shape at both ends of the Score range;
`error-422.json` is the direct route's validation failure body;
`openrouter-error-401.json` is OpenRouter's error envelope, which is not the
vendor's `detail` array.
