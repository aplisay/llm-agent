# Builder eval harness

Phase 3 of the builder cost/quality programme (see polite-ai
`docs/builder-efficiency-review.md`): a repeatable benchmark that runs
scripted build / edit / troubleshoot scenarios through the **real chat loop**
(`lib/text-chat.js` — LLM driver, tool dispatch, MCP connector, usage
metering) in-process, once per candidate model, and reports hard-check
pass/fail, LLM-judge scores, token usage, estimated cost and latency.

## What a run does

For each `model × scenario`:

1. Builds the builtin set-builder definition (`lib/set-builder-agent.js`) with
   the candidate `modelName`, under a disposable org/user created for the run.
2. Drives a chat session through a fake websocket: scripted user turns,
   scripted answers to `ask_user` questions, test offers declined. Exactly the
   production code path — including the aplisay docs MCP connector.
3. Hard checks the saved artefacts (set membership, link wiring, voice
   options, patch discipline, …) — deterministic pass/fail per scenario.
4. Has a fixed judge model (Claude Opus by default, `EVAL_JUDGE_MODEL` to
   override) score prompt quality / faithfulness / efficiency out of 10.
5. Reads the session's token usage straight from `usage_records` (the chat
   loop meters it exactly as production does) and prices it from the table in
   `run.mjs`.

## Running

Point `POSTGRES_*` at a **disposable** database — the tests container works:

```sh
yarn test:setup    # starts the throwaway Postgres on :5433

POSTGRES_HOST=localhost POSTGRES_PORT=5433 POSTGRES_DB=llmvoicetest \
POSTGRES_USER=testuser POSTGRES_PASSWORD=testpass \
node tools/builder-eval/run.mjs \
  --models text:anthropic/claude-sonnet-5,text:anthropic/claude-haiku-4-5 \
  --scenarios faq-single,receptionist-transfer \
  --json /tmp/builder-eval.json
```

`ANTHROPIC_API_KEY` must be set (plus any other provider keys for their
models). **Runs spend real provider tokens** — a full 6-scenario pass on one
model is very roughly $0.5–1.5 depending on the model.

Omit `--models` for the current default (Sonnet 5); omit `--scenarios` for
all of them. Exit code is non-zero when any run fails its hard check.

## Comparing models (Phase 4)

Non-Anthropic candidates need their driver brought up to scratch first — see
the task list: the OpenAI driver caps output at 1024 tokens and lists no 5.x
models; Gemini's driver mangles nested tool schemas; Kimi has no driver; and
only the Anthropic driver supports the MCP connector the builder's docs
lookups ride on. Until then, cross-vendor rows will fail their hard checks
for reasons that are the DRIVER's fault, not the model's — fix the driver,
then trust the numbers.

## Adding scenarios

Add an entry to `scenarios.mjs`: scripted `turns`, `qa` answers for expected
questions, optional `seed` (set / testResult), a deterministic `check()` and
a `rubric` for the judge. Keep checks about the ARTEFACTS (what got saved),
and leave style judgements to the rubric.
