---
title: User accounts
description: How to let people sign in with an email and password beside API keys, and how an admin activates a new account.
audience: operator
status: current
---

# User accounts

Out of the box, every request needs an API key. That is enough for one person
or one team that shares a key.

Turn on user accounts when several people need their own sign-in. Each person
then signs in to a front end with an email and password. API keys keep working
beside accounts.

## Turn accounts on (compose)

```shell
scripts/compose-setup.sh --accounts
docker compose up -d
docker compose run --rm api node tools/agent-admin.js upgrade-db
```

The first command adds these to `.env`. Values already there are kept.

| Variable | Value |
|---|---|
| `BETTER_AUTH_ENABLED` | `true` |
| `BETTER_AUTH_SECRET` | A random secret that signs sessions. Do not change it later: that signs everyone out |
| `BETTER_AUTH_URL` | `http://localhost:<API_PORT>` |
| `BETTER_AUTH_TRUSTED_ORIGINS` | `http://localhost:<UI_PORT>,http://localhost:3000` |
| `WAITLIST_CALLBACK_URL` | `http://localhost:<UI_PORT>/login`. Where the link in the sign-up email points |

The `upgrade-db` step creates the sign-in tables (`session`, `account`,
`verification`). The server does not create them at start. Without them
sign-up answers 500.

On a public host, set `BETTER_AUTH_URL` to the public address of the API, and
`BETTER_AUTH_TRUSTED_ORIGINS` and `WAITLIST_CALLBACK_URL` to the address
people open the front end at. Sign-in is refused from any other browser
origin.

## How a person gets an account

1. They open the front end and choose "Create account".
2. The server makes the account in the state `provisional`. It can sign in but
   every API request answers 403 `account_pending`.
3. An admin signs in (with the first API key, for example), opens the Users
   tab, activates the account and puts it in an organisation.
4. Within about a minute the person's session starts to work.

To do step 3 without a front end:

```shell
curl -X PATCH "$APLISAY_API/users/<user id>" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"status":"active","organisationId":"<organisation id>"}'
```

`GET /api/users` lists the accounts and their ids.

To stop self sign-up, remove `WAITLIST_CALLBACK_URL` from `.env`. An admin
can still create accounts with `POST /api/users`.

## Email

Verification and password reset emails are written to the API log unless you
set an email provider (`EMAIL_SEND_TYPE` and the variables beside it in
[configuration.md](configuration.md)). On a test instance, read the link from
the log:

```shell
docker compose logs api | grep -i "reset\|verif"
```

Set `BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION=true` only when email is really
sent. Otherwise nobody can finish signing up.

## From source

Set the same variables in `.env`, then:

```shell
yarn auth:migrate
yarn start
```

## Things to know

- A new account has no organisation. Until an admin gives it one it can do
  nothing, even when active.
- The first API key (`BOOTSTRAP_API_KEY`) belongs to a super admin. Keep it
  for administration. Give people accounts, or keys of their own.
- Run `upgrade-db` again after an upgrade that moves the better-auth version.
  See [upgrading.md](upgrading.md).
