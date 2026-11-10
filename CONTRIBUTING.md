# Contributing

Thank you for looking. Bug reports, fixes, docs corrections and deploy recipes
are all welcome, from companies and from individuals.

## Questions and support

- Read [docs/self-hosting/troubleshooting.md](docs/self-hosting/troubleshooting.md)
  first.
- Then open an issue with the "Question" template. Include the output of
  `GET /api/health`.
- Support is best effort. There is no promised response time.
- For a support agreement, or to have Aplisay run the platform for you,
  [contact Aplisay](https://aplisay.com/contact).

## Security problems

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Reporting a bug

Use the "Bug report" template. A good report has:

- the version or commit,
- how you run it (compose, from source, your own deployment),
- the output of `GET /api/health`,
- the steps, what you expected and what happened,
- log lines from the API server and the worker.

Remove API keys, passwords and real phone numbers first.

## Making a change

1. For anything larger than a small fix, open an issue first and say what you
   plan. It saves you work if the change does not fit.
2. Fork, and branch from `next`. `main` holds releases only.
3. Set up: see "If you are changing the code" in [AGENTS.md](AGENTS.md). It
   lists the checks to run for each part of the repo.
4. Keep the pull request to one purpose. Small pull requests are reviewed
   sooner.
5. Open the pull request against `next` and fill in the template.

What we check in review:

- Tests cover the change. `yarn test:no-db` passes.
- A change to the public API updates `api/api-doc.yaml`.
- A new environment variable is in `config/env.schema.json`, and
  `yarn env:generate` has been run.
- Docs are updated when behaviour changes. Feature docs are in `docs/`.
- No secrets, customer names or real phone numbers in code, tests, logs or
  the pull request text.
- The smoke test passes. It runs on every pull request to `next`.

## Docs

Write for someone who has not seen the code. Short sentences, British
spelling, and commands that can be pasted. If a doc gives a command, run it
before you send the change.

## Deploy recipes

A recipe for a cloud or host we do not cover is welcome. Say which version you
tested and on what date. Recipes we cannot test ourselves are marked as
community maintained.

## Licence

The project is under the [MIT licence](LICENCE). By sending a contribution you
agree that it is released under the same licence.

## Conduct

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
