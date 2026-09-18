# CI Testing Setup

This document describes how to run comprehensive tests in a CI environment using Docker Compose.

## Overview

The CI testing setup uses Docker Compose to create an isolated test environment with:
- PostgreSQL database container
- Test runner container that depends on the database
- Proper dependency management and cleanup
- Exit codes that reflect test success/failure

## Files

- `docker-compose.ci.yml` - Docker Compose configuration for CI testing
- `Dockerfile` (`test` target) - Docker image for the test runner
- `scripts/test-ci.sh` - Convenience script to run CI tests
- `.dockerignore` - Files to exclude from Docker build context

## Usage

### Using Yarn Script (Recommended)

```bash
# Run comprehensive tests in CI environment
yarn test:ci
```

### Using Docker Compose Directly

```bash
# Run tests with automatic cleanup
docker-compose -f docker-compose.ci.yml up --abort-on-container-exit --exit-code-from test-runner

# Clean up manually if needed
docker-compose -f docker-compose.ci.yml down -v
```

### Using the Script

```bash
# Run the convenience script
./scripts/test-ci.sh
```

## How It Works

1. **Database Setup**: PostgreSQL container starts with health checks
2. **Dependency Management**: Test runner waits for database to be healthy
3. **Test Execution**: Comprehensive tests run in isolated environment
4. **Exit Codes**: 
   - `0` = All tests passed
   - `1` = Tests failed or setup failed
5. **Cleanup**: Containers are automatically stopped and removed

## One database per jest worker

The suite runs in parallel (`maxWorkers` in `jest.config.db.js`, overridable
with `JEST_WORKERS`). Every DB-backed suite boots `lib/database.js` under
`DB_FORCE_SYNC`, which runs the whole schema upgrade chain, so the workers
cannot share one schema.

`tests/setup/global-setup.js` therefore drops and recreates one database per
worker, `llmvoicetest_1` upwards, before any worker starts, and
`tests/setup/database-test-wrapper.js` points `lib/database.js` at the one
belonging to its own worker. Connection details live in
`tests/setup/test-db-config.js`.

Two consequences worth knowing:

- Every suite that reaches Postgres must go through `database-test-wrapper.js`.
  A suite that imports `lib/database.js` on its own gets no database name and
  will not connect. The wrapper is the only place that assigns one.
- The databases are recreated on every run, so a rerun no longer inherits rows
  from the last one. Starting from a clean volume is no longer needed to avoid
  phantom failures.

## Environment Variables

The test runner container uses these environment variables:

- `POSTGRES_HOST=postgres` (internal Docker network)
- `POSTGRES_PORT=5432`
- `POSTGRES_DB=llmvoicetest` (the bootstrap database only, see below: suites run
  against `llmvoicetest_<worker>`)
- `POSTGRES_USER=testuser`
- `POSTGRES_PASSWORD=testpass`
- `CREDENTIALS_KEY=test-secret-key-for-comprehensive-tests`
- `DB_FORCE_SYNC=true`
- `NODE_ENV=test`
- `LOGLEVEL=fatal`

## CI Integration

For Google Cloud Build or other CI systems, use:

```yaml
# cloudbuild.yaml example
steps:
  - name: 'gcr.io/cloud-builders/docker'
    args: ['compose', '-f', 'docker-compose.ci.yml', 'up', '--abort-on-container-exit', '--exit-code-from', 'test-runner']
```

## Troubleshooting

### Build Issues
- Ensure Node.js 20+ is available
- Check that all dependencies are properly installed
- Verify Docker and Docker Compose are installed

### Test Failures
- Check database connectivity
- Verify environment variables are set correctly
- Review test logs for specific error messages

### Cleanup Issues
- Manually stop containers: `docker-compose -f docker-compose.ci.yml down -v`
- Remove images: `docker rmi llm-agent-test-runner:latest`
- Clean up volumes: `docker volume prune`
