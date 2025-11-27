# Test Coverage Documentation

This document describes the test coverage setup for the comprehensive phone endpoints API tests.

## Coverage Configuration

The comprehensive tests are configured to collect coverage data using Jest with the following setup:

### Jest Configuration (`jest.config.comprehensive.js`)

- **Coverage Collection**: Enabled with `collectCoverage: true`
- **Coverage Directory**: `coverage/comprehensive/`
- **Coverage Reporters**: `text`, `lcov`, `html`, `json`
- **Coverage Thresholds**: 
  - Branches: 10%
  - Functions: 15%
  - Lines: 25%
  - Statements: 25%

### Excluded Files

The following files are excluded from coverage collection to focus on core functionality:

- `/node_modules/`
- `/tests/`
- `/coverage/`
- `/agents/`
- `/api/`
- `/lib/handlers/`
- `/lib/models/`
- `/lib/voices/`
- `/lib/utils/`
- Various LLM and model files

## Running Tests with Coverage

### Local Development

```bash
# Start test database
docker-compose -f tests/docker-compose.test.yml up -d

# Run comprehensive tests with coverage
yarn test:coverage

# Clean up
docker-compose -f tests/docker-compose.test.yml down -v
```

### CI Environment

```bash
# Run comprehensive tests in CI with coverage
yarn test:ci
```

## Coverage Reports

### HTML Report

The HTML coverage report is generated at `coverage/comprehensive/index.html` and provides:

- Interactive file-by-file coverage analysis
- Line-by-line coverage highlighting
- Branch coverage details
- Function coverage metrics

### Text Report

Coverage summary is displayed in the terminal:

```
-------------|---------|----------|---------|---------|--------------
File         | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
-------------|---------|----------|---------|---------|--------------
All files    |   33.94 |    15.32 |   21.73 |   34.21 |
database.js  |    33.7 |    12.93 |   21.73 |   33.96 | 76-77,85-110,...
logger.js    |     100 |       50 |     100 |     100 | 4-16
-------------|---------|----------|---------|---------|--------------
```

### LCOV Report

LCOV format report is available at `coverage/comprehensive/lcov.info` for integration with external tools.

## Current Coverage Status

The comprehensive tests currently achieve:

- **Statements**: ~34%
- **Branches**: ~15%
- **Functions**: ~22%
- **Lines**: ~34%

## Coverage Goals

The coverage thresholds are set to ensure minimum coverage levels:

- **Branches**: 10% (current: 15% ✅)
- **Functions**: 15% (current: 22% ✅)
- **Lines**: 25% (current: 34% ✅)
- **Statements**: 25% (current: 34% ✅)

## Improving Coverage

To improve test coverage:

1. **Add more test cases** for edge cases and error conditions
2. **Test different code paths** in conditional statements
3. **Add integration tests** for complex workflows
4. **Test error handling** scenarios

## Files with Coverage

### Core Files
- `lib/database.js` - Database models and connections
- `lib/logger.js` - Logging functionality
- `lib/validation.js` - Input validation

### Test Files
- `tests/phone-endpoints-comprehensive.test.mjs` - Main comprehensive test suite
- `tests/setup/real-database-test.js` - Real database test setup
- `tests/setup/test-api-helpers.js` - Test API helper functions

## Integration with CI/CD

The coverage reports are automatically generated in CI environments and can be:

1. **Uploaded to coverage services** (e.g., Codecov, Coveralls)
2. **Used for quality gates** in pull request reviews
3. **Tracked over time** to monitor coverage trends

## Best Practices

1. **Maintain coverage thresholds** - Don't lower them without justification
2. **Review uncovered lines** - Ensure they're intentionally excluded or add tests
3. **Focus on critical paths** - Prioritize coverage of business logic over utility functions
4. **Regular coverage reviews** - Check coverage reports during code reviews
