---
title: Upgrading
description: How to move a self-hosted instance to a newer version, including the database schema step.
audience: operator
status: current
---

# Upgrading

## Before you start

- Read the release notes for every version between yours and the new one:
  [../release-notes/](../release-notes/).
- Back up the database. With the compose stack:

  ```shell
  docker compose exec postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > backup.sql
  ```

- Keep your `.env`. Never change `CREDENTIALS_KEY`: stored SIP passwords and
  agent keys are encrypted with it.

## Upgrade the compose stack

```shell
git fetch --tags
git checkout <version tag>
docker compose up --build -d
docker compose logs api | grep -i database
```

## The database schema step

The API server holds a schema version number. At start it compares that number
with the one stored in the database.

- **New, empty database.** The server creates the schema. Nothing to do.
- **Same version.** Nothing to do.
- **The code is newer than the database.** In production mode the server does
  not change an existing schema by itself. It logs
  `version mismatch, wont upgrade` and carries on with the old schema. New
  features that need new columns will fail until you upgrade.
- **The database is newer than the code.** The server logs
  `Database version mismatch`. You are running an older version against a
  newer database. Go back to the newer version.

To upgrade the schema, run this once, with the API server's environment:

```shell
# compose stack
docker compose run --rm api node tools/agent-admin.js upgrade-db

# from source
node tools/agent-admin.js upgrade-db
```

It alters the tables to match the new version, then records the new version
number. Run it before, or straight after, you start the new API server. If you
run several API server replicas, run it once: the schema work is serialised by
a database lock.

Setting `DB_FORCE_SYNC=true` for one start of the API server does the same
work. Remove it afterwards. Do not leave it set in production.

In development mode (`yarn develop`) the schema syncs at every start, so this
step is only for production and staging modes.

## Upgrade the workers with the API server

Run the same version of the API server and the voice workers. The workers call
internal API routes that can change between versions. In the compose stack
`docker compose up --build` rebuilds both.

## Check the result

```shell
curl http://localhost:4000/api/health
```

`database.ok` must be `true`. `build` shows the commit and tag for a released
image. An image you built yourself shows `null` there.
