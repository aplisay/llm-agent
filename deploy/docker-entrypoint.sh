#!/bin/sh
# Container entrypoint for the llm-agent Cloud Run image.
#
# Ensures better-auth's satellite tables (account/session/verification) exist
# before serving. Without this, a fresh staging/prod DB makes every credential
# sign-up 500 with `relation "account" does not exist` BEFORE the
# verification-email hook runs — "sign-up works but no confirmation email".
# See scripts/auth-migrate.mjs and docs/implementation/better-auth-hardening-plan.md §G.
#
# The migrate is idempotent, fenced off the Sequelize-owned `users` table, and a
# no-op when BETTER_AUTH_ENABLED != true. Fail-closed: a migrate error aborts
# boot (set -e) so Cloud Run keeps the previous healthy revision serving.
set -e

node scripts/auth-migrate.mjs

exec yarn start
