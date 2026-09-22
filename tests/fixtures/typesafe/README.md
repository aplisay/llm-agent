# TypeSafe Jev fixtures

Request and response bodies for the decision-model tests
(`tests/typesafe-model.test.mjs`, `tests/subagent-decision.test.mjs`,
`tests/typesafe-validation.test.mjs`).

Each file records its provenance in a `source` field:

- `recorded` files are verbatim bodies from a live exchange, with the date
  and route in `note`. `six-questions.json`, `score-two-levels.json` and
  `score-ten-levels.json` were recorded on 2026-09-22 on the OpenRouter
  route by the P0 spike (`aplisay-strategy/research/jev-spike.mjs`, which
  rewrites them with `RECORD_FIXTURES=<this directory>`).
  `openrouter-error-400.json` and `openrouter-error-401.json` are
  OpenRouter's error envelope, which is not the vendor's `detail` array.
- `schema` files follow the vendor's published OpenAPI document
  (`https://api.typesafe.ai/openapi.json`, version 0.2.0, read on
  2026-09-22). `error-422.json` is the direct route's validation failure
  body, which no key was available to record.

`six-questions.json` is the spec's default post-call question set against an
escalation transcript; the two Score files show the `legend` and
`probabilities` shape at both ends of the Score range. The tests derive their
expectations from the bodies, so a re-recording needs no test edits.
