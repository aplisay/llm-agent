#!/bin/bash

# CI Test Script for Phone Endpoints API
# This script runs comprehensive tests in a Docker environment

set -e  # Exit on any error

echo "🚀 Starting CI test environment..."

# Run the comprehensive tests using Docker Compose
echo "📦 Building and running test containers..."
docker-compose -f docker-compose.ci.yml up --abort-on-container-exit --exit-code-from test-runner

# Capture the exit code
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
    echo "✅ All comprehensive tests passed!"
else
    echo "❌ Tests failed with exit code: $EXIT_CODE"
fi

# Clean up containers
echo "🧹 Cleaning up containers..."
docker-compose -f docker-compose.ci.yml down -v

exit $EXIT_CODE
