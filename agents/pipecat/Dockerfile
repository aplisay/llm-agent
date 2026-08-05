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

# ONLY_TRANSPORTS: comma-separated allow-list (no spaces) of transports this
# image should carry, matching the cloudbuild _ONLY_TRANSPORTS substitution.
# Empty (the default) = all. The only transport with a worker-side install
# cost is "daily": daily-python is a ~14 MB native wheel nothing else uses, so
# the gate skips that single package and leaves the uv.lock resolution alone.
ARG ONLY_TRANSPORTS=
RUN case ",$ONLY_TRANSPORTS," in \
        ",,"|*",daily,"*) \
            uv sync --frozen --no-cache || uv sync --no-cache ;; \
        *) \
            echo "ONLY_TRANSPORTS=$ONLY_TRANSPORTS: skipping daily-python"; \
            uv sync --frozen --no-cache --no-install-package daily-python \
                || uv sync --no-cache --no-install-package daily-python ;; \
    esac

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

# --no-sync: the environment was fully materialised at build time; without it
# `uv run` re-syncs against the lock at container start, which would reinstall
# a daily-python that an ONLY_TRANSPORTS build deliberately excluded.
ENTRYPOINT ["uv", "run", "--no-sync", "python", "-m", "pipecat_aplisay"]
