# Testing Rationalization

This document explains the rationalized testing setup for the llm-agent project.

## Test Scripts

### `yarn test:db`
- **Purpose**: Starts the test database container, runs database-dependent tests, then stops the container
- **Behavior**: 
  1. Starts PostgreSQL container via Docker Compose
  2. Runs `yarn test` (which runs database tests)
  3. Stops and removes the container
- **Tests**: Phone endpoints comprehensive tests, phone registration tests
- **Coverage**: Full coverage reporting for database-dependent code

### `yarn test`
- **Purpose**: Runs database-dependent tests (assumes database is already running)
- **Behavior**: Runs tests that require a database connection
- **Tests**: Phone endpoints comprehensive tests, phone registration tests
- **Coverage**: Full coverage reporting for database-dependent code

### `yarn test:no-db`
- **Purpose**: Runs only tests that don't require a database
- **Behavior**: Runs tests that don't need database connectivity
- **Tests**: LLM model tests, voice tests, handler tests, utility tests
- **Coverage**: Basic coverage reporting (no thresholds)

## Jest Configurations

### `jest.config.db.js`
- **Purpose**: Configuration for database-dependent tests
- **Tests**: `phone-endpoints-comprehensive.test.mjs`, `phone-registration.test.mjs`
- **Coverage**: Full coverage with thresholds
- **Timeout**: 60 seconds (for database operations)
- **Workers**: 1 (sequential execution to avoid database conflicts)

### `jest.config.no-db.js`
- **Purpose**: Configuration for non-database tests
- **Tests**: All other test files (LLM, voices, handlers, etc.)
- **Coverage**: Basic coverage reporting (no thresholds)
- **Timeout**: 30 seconds
- **Workers**: 1

### `jest.config.js` (legacy)
- **Purpose**: Default configuration (kept for compatibility)
- **Tests**: All tests matching `**/tests/*.test.mjs`
- **Coverage**: Full coverage with thresholds

## Test Categories

### Database-Dependent Tests
- `tests/phone-endpoints-comprehensive.test.mjs`
- `tests/phone-registration.test.mjs`

### Non-Database Tests
- `tests/gpt.test.mjs`
- `tests/groq.test.mjs`
- `tests/anthropic-simple.test.mjs`
- `tests/voices.test.mjs`
- `tests/handler.test.mjs`
- `agents/jambonz/tests/jambonz.test.mjs`

## Coverage Reporting

### Database Tests
- **Directory**: `coverage/db/`
- **Thresholds**: 25% statements, 25% lines, 15% functions, 10% branches
- **Includes**: API endpoints, database models, registration simulation

### Non-Database Tests
- **Directory**: `coverage/no-db/`
- **Thresholds**: No minimum thresholds (0%)
- **Includes**: Core library functions, utilities

## Usage Examples

```bash
# Run all tests with database (starts container automatically)
yarn test:db

# Run database tests (assumes database is running)
yarn test

# Run only non-database tests
yarn test:no-db

# Run CI tests (Docker Compose with database)
yarn test:ci

# Clean up database container
yarn test:cleanup
```

## CI Configuration

The `test:ci` script uses Docker Compose to run database tests in a containerized environment:

- **Database**: PostgreSQL 15 container
- **Test Runner**: Node.js container with all dependencies
- **Configuration**: Uses `jest.config.db.js` for database tests
- **Environment**: Full containerized environment with proper networking
- **Coverage**: Full coverage reporting for database-dependent code

## Benefits

1. **Clear Separation**: Database vs non-database tests are clearly separated
2. **Faster Development**: Non-database tests run quickly without container overhead
3. **CI/CD Friendly**: Database tests can be run in CI with proper container management
4. **Coverage Focus**: Database tests have meaningful coverage thresholds
5. **Simplified Scripts**: Reduced number of test scripts in package.json
