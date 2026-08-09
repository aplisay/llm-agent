#!/usr/bin/env bash
#
# bundle-secretenv.sh — generate a SECRETENV_KEY + SECRETENV_BUNDLE pair from a
# .env file and publish it to Google Secret Manager for the LiveKit agent
# deploy.
#
# Replicated from aplisay-sbc/deploy/gcp/bundle-secretenv.sh (itself derived
# from the pipecat deploy's bundler), trimmed to the GCP backend — the LiveKit
# agent only deploys to GCE VMs via docker compose.
#
# IMPORTANT — the LiveKit agent shares the llm-agent server's secret pair. The
# names are NOT livekit-specific, and they are the ones the Cloud Build image
# builds and the Cloud Run llm-agent service also consume:
#
#   dev         SECRETENV_DEV_KEY      / SECRETENV_DEV_BUNDLE
#   staging     SECRETENV_STAGING_KEY  / SECRETENV_STAGING_BUNDLE
#   beta        SECRETENV_BETA_KEY     / SECRETENV_BETA_BUNDLE
#   production  SECRETENV_KEY          / SECRETENV_BUNDLE      (unsuffixed!)
#
# Publishing --env=production therefore rotates the platform-wide production
# bundle: every service that reads it picks up the new version on its next
# deploy / restart. The script says so and asks for confirmation. Override the
# naming with --secret-base=NAME if you want an agent-specific pair instead.
#
# These names match the GOOGLE_SECRETENV_PATH already in
# env-example-{staging,production}; deploy-node.sh appends _KEY / _BUNDLE and
# installs both onto the VM as ~/livekit-agent/.env.secretenv.
#
# Environment (dev / staging / beta / production) chooses both:
#   - the source .env file at the repo root (.env / .env.<env>)
#   - the secret-name suffix
#
# Usage (run from agents/livekit/deploy/gcp):
#   ./bundle-secretenv.sh                       # interactive
#   ./bundle-secretenv.sh --env=staging --yes
#   ./bundle-secretenv.sh --env=production --file=path/to/.env
#   ./bundle-secretenv.sh --env=staging --secret-base=SECRETENV_LIVEKIT_STAGING
#   ./bundle-secretenv.sh --dry-run             # plan only, no writes
#
# Requirements:
#   - gcloud (publish), openssl (key), node (+ npx)
#   - the encryption uses the repo's local `secretenv` (node_modules) when
#     present, so the bundle is wire-identical to what the container decrypts;
#     otherwise it pulls github:rjp44/secretenv via npx.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

ENVIRONMENT=""
ENV_FILE=""
SECRET_BASE=""
ASSUME_YES=0
DRY_RUN=0

while [ $# -gt 0 ]; do
    case "$1" in
        --env=*)         ENVIRONMENT="${1#*=}"; shift ;;
        --env)           ENVIRONMENT="${2:-}"; shift 2 ;;
        --file=*)        ENV_FILE="${1#*=}"; shift ;;
        --file)          ENV_FILE="${2:-}"; shift 2 ;;
        --secret-base=*) SECRET_BASE="${1#*=}"; shift ;;
        --secret-base)   SECRET_BASE="${2:-}"; shift 2 ;;
        --yes|-y)        ASSUME_YES=1; shift ;;
        --dry-run)       DRY_RUN=1; shift ;;
        -h|--help)
            sed -n '2,/^set /p' "$0" | sed -n '/^# /p' | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo -e "${RED}Unknown arg: $1${NC}" >&2; exit 2 ;;
    esac
done

# ---- Environment -------------------------------------------------------------

if [ -z "$ENVIRONMENT" ]; then
    read -p "Environment (dev/staging/beta/production) [staging]: " ENVIRONMENT
    ENVIRONMENT=${ENVIRONMENT:-staging}
fi
case "$ENVIRONMENT" in
    dev|staging|beta|production) ;;
    *) echo -e "${RED}Invalid environment '$ENVIRONMENT' (use dev|staging|beta|production)${NC}" >&2; exit 2 ;;
esac

# Production is the unsuffixed pair; every other environment is suffixed.
if [ -z "$SECRET_BASE" ]; then
    case "$ENVIRONMENT" in
        production) SECRET_BASE="SECRETENV" ;;
        *)          SECRET_BASE="SECRETENV_$(printf '%s' "$ENVIRONMENT" | tr '[:lower:]' '[:upper:]')" ;;
    esac
fi

# ---- Source .env (the secrets to bundle) -------------------------------------
#
# Defaults to the repo-root env file (.env / .env.<env>) — that's the single
# source of truth for the platform's runtime secrets. Override with --file.
if [ -z "$ENV_FILE" ]; then
    case "$ENVIRONMENT" in
        dev) ENV_FILE="$REPO_ROOT/.env" ;;
        *)   ENV_FILE="$REPO_ROOT/.env.$ENVIRONMENT" ;;
    esac
fi
if [ ! -f "$ENV_FILE" ]; then
    echo -e "${RED}Env file not found: $ENV_FILE${NC}" >&2
    echo -e "${RED}Pass --file=<path> to point at a different .env.${NC}" >&2
    exit 1
fi

# Don't bundle our own SECRETENV_* lines back in (circular at decrypt time).
if grep -qE '^(export[[:space:]]+)?SECRETENV_(KEY|BUNDLE)=' "$ENV_FILE"; then
    echo -e "${YELLOW}Warning: $ENV_FILE contains a SECRETENV_KEY/_BUNDLE line; it will be encrypted into the new bundle. Remove it if you meant it as the active pair.${NC}" >&2
fi

# ---- Tool checks -------------------------------------------------------------

require() { command -v "$1" >/dev/null 2>&1 || { echo -e "${RED}Required tool not found: $1${NC}" >&2; exit 3; }; }
require gcloud
require openssl
require node

# ---- PROJECT_ID (from the deploy config, not the secrets source) -------------

PROJECT_ID=""
for f in "$SCRIPT_DIR/.env.$ENVIRONMENT" "$SCRIPT_DIR/env-example-$ENVIRONMENT"; do
    [ -f "$f" ] || continue
    PROJECT_ID=$(grep -E '^PROJECT_ID=' "$f" | head -1 | cut -d= -f2- | tr -d '[:space:]"'"'"'')
    [ -n "$PROJECT_ID" ] && break
done
[ -n "$PROJECT_ID" ] || PROJECT_ID=$(gcloud config get-value project 2>/dev/null || true)
if [ -z "$PROJECT_ID" ]; then
    echo -e "${RED}Could not determine GCP PROJECT_ID (not in .env.$ENVIRONMENT or env-example-$ENVIRONMENT, no gcloud default).${NC}" >&2
    exit 1
fi

# ---- Plan + confirm ----------------------------------------------------------

echo
echo -e "${YELLOW}Plan:${NC}"
echo -e "  Environment:  ${GREEN}$ENVIRONMENT${NC}"
echo -e "  Source .env:  ${GREEN}$ENV_FILE${NC}"
echo -e "  GCP project:  ${GREEN}$PROJECT_ID${NC}"
echo -e "  Secrets:      ${GREEN}${SECRET_BASE}_KEY${NC} + ${GREEN}${SECRET_BASE}_BUNDLE${NC}"
[ "$DRY_RUN" = 1 ] && echo -e "  Mode:         ${YELLOW}DRY RUN (no writes)${NC}"
if [ "$SECRET_BASE" = "SECRETENV" ]; then
    echo
    echo -e "  ${RED}This is the shared PRODUCTION pair.${NC} Cloud Run llm-agent, the jambonz"
    echo -e "  ${RED}agent, the livekit-agent image build and the GCE runners all read it.${NC}"
    echo -e "  ${RED}A new version takes effect on each of them at their next restart.${NC}"
fi
echo

if [ "$ASSUME_YES" != 1 ] && [ "$DRY_RUN" != 1 ]; then
    read -p "Proceed? [y/N]: " -n 1 -r REPLY; echo
    [[ "$REPLY" =~ ^[Yy]$ ]] || { echo -e "${RED}Cancelled.${NC}"; exit 0; }
fi

# ---- Generate key + bundle ---------------------------------------------------
#
# Fresh random key (never written to disk); bundle = the .env AES-256-CBC
# encrypted with HMAC-SHA256(key="secretenv", msg=KEY). Prefer the repo's
# installed secretenv so the bundle matches the container's exact version.

SECRETENV_KEY=$(openssl rand -base64 36 | tr -d '\n')
export SECRETENV_KEY

encrypt_bundle() {
    local file="$1"
    if [ -f "$REPO_ROOT/node_modules/secretenv/bin/secretenv.js" ]; then
        node "$REPO_ROOT/node_modules/secretenv/bin/secretenv.js" -p "$file" -e 2>/dev/null
    elif [ -f "$REPO_ROOT/node_modules/dotenv/bin/secretenv.js" ]; then
        # The repo aliases dotenv -> github:rjp44/secretenv.
        node "$REPO_ROOT/node_modules/dotenv/bin/secretenv.js" -p "$file" -e 2>/dev/null
    else
        command -v npx >/dev/null 2>&1 || { echo -e "${RED}npx not found and no local node_modules/secretenv${NC}" >&2; exit 3; }
        npx --yes --quiet -p github:rjp44/secretenv secretenv -p "$file" -e 2>/dev/null
    fi
}

echo -e "${YELLOW}Encrypting $ENV_FILE …${NC}" >&2
BUNDLE_LINE=$(encrypt_bundle "$ENV_FILE" || true)
if [ -z "${BUNDLE_LINE:-}" ] || [ "${BUNDLE_LINE#SECRETENV_BUNDLE=}" = "$BUNDLE_LINE" ]; then
    echo -e "${RED}Failed to produce SECRETENV_BUNDLE from $ENV_FILE.${NC}" >&2
    exit 1
fi
SECRETENV_BUNDLE="${BUNDLE_LINE#SECRETENV_BUNDLE=}"

if [ "$DRY_RUN" = 1 ]; then
    echo -e "${GREEN}Bundle generated (${#SECRETENV_BUNDLE} chars). Dry-run — not publishing.${NC}"
    unset SECRETENV_KEY SECRETENV_BUNDLE
    exit 0
fi

# ---- Publish to Secret Manager ----------------------------------------------

publish() {
    local name value
    for pair in "${SECRET_BASE}_KEY|$SECRETENV_KEY" "${SECRET_BASE}_BUNDLE|$SECRETENV_BUNDLE"; do
        name="${pair%%|*}"; value="${pair#*|}"
        if gcloud secrets describe "$name" --project="$PROJECT_ID" >/dev/null 2>&1; then
            echo -e "${YELLOW}  $name exists — adding a new version${NC}"
            printf '%s' "$value" | gcloud secrets versions add "$name" --project="$PROJECT_ID" --data-file=- >/dev/null
        else
            echo -e "${YELLOW}  Creating $name${NC}"
            printf '%s' "$value" | gcloud secrets create "$name" --project="$PROJECT_ID" --replication-policy=automatic --data-file=- >/dev/null
        fi
    done
}
publish

echo
echo -e "${GREEN}Done.${NC} The runner VMs' service account needs ${GREEN}roles/secretmanager.secretAccessor${NC}"
echo -e "on these secrets (or on the project). If not already granted:"
echo
echo -e "  ${YELLOW}for s in ${SECRET_BASE}_KEY ${SECRET_BASE}_BUNDLE; do${NC}"
echo -e "  ${YELLOW}  gcloud secrets add-iam-policy-binding \"\$s\" \\${NC}"
echo -e "  ${YELLOW}    --project=$PROJECT_ID --role=roles/secretmanager.secretAccessor \\${NC}"
echo -e "  ${YELLOW}    --member=serviceAccount:<VM-service-account>${NC}"
echo -e "  ${YELLOW}done${NC}"
echo
echo -e "Roll the runners onto the new version with:"
echo -e "  ${GREEN}./deploy-node.sh --env=$ENVIRONMENT --components=secrets${NC}"
echo -e "(the deploy env already points at these via GOOGLE_SECRETENV_PATH=projects/<PROJECT_NUMERIC_ID>/secrets/${SECRET_BASE})"

unset SECRETENV_KEY SECRETENV_BUNDLE BUNDLE_LINE
