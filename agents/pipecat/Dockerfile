FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
        build-essential \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Use uv (the Pipecat-recommended tool) for dependency installation.
RUN pip install --no-cache-dir uv

WORKDIR /usr/src/app
COPY agents/pipecat /usr/src/app

RUN uv sync --frozen --no-cache || uv sync --no-cache

# Build identity — baked from Cloud Build's COMMIT_SHA / BRANCH_NAME / TAG_NAME
# and logged at startup by pipecat_aplisay.build_info (mirrors the Node image's
# BUILD_COMMIT). Declared late so a new commit doesn't invalidate the apt/uv
# layers above.
ARG COMMIT_SHA
ARG BRANCH_NAME
ARG TAG_NAME
ENV BUILD_COMMIT=$COMMIT_SHA \
    BUILD_BRANCH=$BRANCH_NAME \
    BUILD_TAG=$TAG_NAME

EXPOSE 8082
ENV PORT=8082

ENTRYPOINT ["uv", "run", "python", "-m", "pipecat_aplisay"]
