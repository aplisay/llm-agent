#!/usr/bin/env bash
#
# bundle-secretenv.sh — generate a SECRETENV_KEY + SECRETENV_BUNDLE pair from a
# .env file and publish it to the right secret backend for this deploy.
#
# Backend is auto-detected from the directory you run it in:
#
#   .../agents/pipecat/deploy/gcp   →  Google Secret Manager. Creates two
#                                      secrets per environment:
#                                        SECRETENV_PIPECAT_{ENV}_KEY
#                                        SECRETENV_PIPECAT_{ENV}_BUNDLE
#                                      These match the GOOGLE_SECRETENV_PATH
#                                      pattern in env-example-{staging,production}
#                                      (the loader appends _KEY / _BUNDLE).
#
#   .../agents/pipecat/deploy/k8s   →  Kubernetes Secret in the `pipecat`
#                                      namespace:
#                                        pipecat-secretenv-{env}   (per env)
#                                        pipecat-secretenv         (alias to the
#                                                                   one just
#                                                                   written —
#                                                                   the name the
#                                                                   overlays use)
#                                      Both contain the same two keys:
#                                        SECRETENV_KEY, SECRETENV_BUNDLE
#
# Environment is interactive (dev / staging / production), and chooses both:
#   - the source .env file (.env / .env.staging / .env.production) in cwd
#   - the secret name suffix (dev, staging, production)
#
# Usage:
#   cd agents/pipecat/deploy/gcp        # OR .../deploy/k8s
#   ../bundle-secretenv.sh              # interactive
#   ../bundle-secretenv.sh --env=staging --yes
#   ../bundle-secretenv.sh --backend=k8s --env=production --file=path/to/.env
#   ../bundle-secretenv.sh --dry-run    # plan only, no writes
#
# Requirements:
#   - node + npx (the script pulls github:rjp44/secretenv via npx to do the
#     encryption — same package the esl-poller sidecar already uses, so the
#     bundle is wire-compatible with every container's decryption path)
#   - gcloud (gcp backend) or kubectl (k8s backend)
#   - openssl

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

BACKEND=""
ENVIRONMENT=""
ENV_FILE=""
ASSUME_YES=0
DRY_RUN=0

while [ $# -gt 0 ]; do
    case "$1" in
        --backend=*)    BACKEND="${1#*=}"; shift ;;
        --backend)      BACKEND="${2:-}"; shift 2 ;;
        --env=*)        ENVIRONMENT="${1#*=}"; shift ;;
        --env)          ENVIRONMENT="${2:-}"; shift 2 ;;
        --file=*)       ENV_FILE="${1#*=}"; shift ;;
        --file)         ENV_FILE="${2:-}"; shift 2 ;;
        --yes|-y)       ASSUME_YES=1; shift ;;
        --dry-run)      DRY_RUN=1; shift ;;
        -h|--help)
            sed -n '2,/^set /p' "$0" | sed -n '/^# /p' | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown arg: $1${NC}" >&2
            exit 2
            ;;
    esac
done

# ---- Backend: cwd auto-detect, override with --backend -----------------------

if [ -z "$BACKEND" ]; then
    case "$(pwd)" in
        */agents/pipecat/deploy/gcp|*/agents/pipecat/deploy/gcp/*) BACKEND=gcp ;;
        */agents/pipecat/deploy/k8s|*/agents/pipecat/deploy/k8s/*) BACKEND=k8s ;;
        *)
            echo -e "${RED}Cannot detect backend from $(pwd).${NC}" >&2
            echo -e "${RED}Run from agents/pipecat/deploy/gcp or .../deploy/k8s, or pass --backend=gcp|k8s.${NC}" >&2
            exit 2
            ;;
    esac
fi

case "$BACKEND" in
    gcp|k8s) ;;
    *) echo -e "${RED}--backend must be gcp or k8s (got '$BACKEND')${NC}" >&2; exit 2 ;;
esac

# ---- Environment: interactive prompt or --env --------------------------------

if [ -z "$ENVIRONMENT" ]; then
    read -p "Environment (dev/staging/production) [staging]: " ENVIRONMENT
    ENVIRONMENT=${ENVIRONMENT:-staging}
fi

case "$ENVIRONMENT" in
    dev|staging|production) ;;
    *) echo -e "${RED}Invalid environment '$ENVIRONMENT' (use dev|staging|production)${NC}" >&2; exit 2 ;;
esac
ENV_UPPER=$(printf '%s' "$ENVIRONMENT" | tr '[:lower:]' '[:upper:]')

# ---- Source .env file --------------------------------------------------------

if [ -z "$ENV_FILE" ]; then
    case "$ENVIRONMENT" in
        dev) ENV_FILE="$(pwd)/.env" ;;
        *)   ENV_FILE="$(pwd)/.env.$ENVIRONMENT" ;;
    esac
fi
if [ ! -f "$ENV_FILE" ]; then
    echo -e "${RED}Env file not found: $ENV_FILE${NC}" >&2
    echo -e "${RED}Pass --file=<path> to point at a different .env.${NC}" >&2
    exit 1
fi

# Sanity: refuse to bundle our own SECRETENV_* lines back into the bundle (would
# be a foot-gun — circular reference at decrypt time).
if grep -qE '^(export[[:space:]]+)?SECRETENV_(KEY|BUNDLE)=' "$ENV_FILE"; then
    echo -e "${YELLOW}Warning: $ENV_FILE already contains a SECRETENV_KEY or _BUNDLE line.${NC}" >&2
    echo -e "${YELLOW}Those will be encrypted into the new bundle and overwritten at decrypt — that's fine for SECRETS, but if you intended them as the active key/bundle pair, remove them first.${NC}" >&2
fi

# ---- Tool checks -------------------------------------------------------------

require() {
    command -v "$1" >/dev/null 2>&1 || { echo -e "${RED}Required tool not found: $1${NC}" >&2; exit 3; }
}
require openssl
require node
require npx
case "$BACKEND" in
    gcp) require gcloud ;;
    k8s) require kubectl ;;
esac

# ---- Confirm -----------------------------------------------------------------

case "$BACKEND" in
    gcp)
        # PROJECT_ID is read from the same .env (matches deploy-node.sh).
        PROJECT_ID=$(grep -E '^PROJECT_ID=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '[:space:]"'"'"'')
        if [ -z "$PROJECT_ID" ]; then
            PROJECT_ID=$(gcloud config get-value project 2>/dev/null || true)
        fi
        if [ -z "$PROJECT_ID" ]; then
            echo -e "${RED}Could not determine GCP PROJECT_ID (not in $ENV_FILE, no gcloud default).${NC}" >&2
            exit 1
        fi
        TARGET_DESC="GCP project ${GREEN}$PROJECT_ID${NC} — secrets ${GREEN}SECRETENV_PIPECAT_${ENV_UPPER}_KEY${NC} + ${GREEN}SECRETENV_PIPECAT_${ENV_UPPER}_BUNDLE${NC}"
        ;;
    k8s)
        NAMESPACE=${NAMESPACE:-pipecat}
        TARGET_DESC="Kubernetes namespace ${GREEN}$NAMESPACE${NC} — secrets ${GREEN}pipecat-secretenv-${ENVIRONMENT}${NC} + alias ${GREEN}pipecat-secretenv${NC}"
        ;;
esac

echo
echo -e "${YELLOW}Plan:${NC}"
echo -e "  Backend:       ${GREEN}$BACKEND${NC}"
echo -e "  Environment:   ${GREEN}$ENVIRONMENT${NC}"
echo -e "  Source .env:   ${GREEN}$ENV_FILE${NC}"
echo -e "  Destination:   $TARGET_DESC"
[ "$DRY_RUN" = 1 ] && echo -e "  Mode:          ${YELLOW}DRY RUN (no writes)${NC}"
echo

if [ "$ASSUME_YES" != 1 ] && [ "$DRY_RUN" != 1 ]; then
    read -p "Proceed? [y/N]: " -n 1 -r REPLY
    echo
    [[ "$REPLY" =~ ^[Yy]$ ]] || { echo -e "${RED}Cancelled.${NC}"; exit 0; }
fi

# ---- Generate key + bundle ---------------------------------------------------
#
# The key is a fresh random passphrase; never written to disk. The bundle is the
# .env contents AES-256-CBC-encrypted with HMAC-SHA256(key="secretenv", msg=KEY).
# We use the canonical CLI (github:rjp44/secretenv pinned to v1.0.5) so the
# bundle is wire-identical to what every container's decryption path is tested
# against. npx fetches and caches; subsequent runs reuse the cache.

SECRETENV_KEY=$(openssl rand -base64 36 | tr -d '\n')
export SECRETENV_KEY

# secretenv emits a single line: "SECRETENV_BUNDLE=<iv_hex>:<base64ct>".
echo -e "${YELLOW}Encrypting $ENV_FILE …${NC}" >&2
BUNDLE_LINE=$(npx --yes --quiet -p github:rjp44/secretenv#v1.0.5 secretenv -p "$ENV_FILE" -e 2>/dev/null || true)
if [ -z "${BUNDLE_LINE:-}" ] || [ "${BUNDLE_LINE#SECRETENV_BUNDLE=}" = "$BUNDLE_LINE" ]; then
    echo -e "${RED}Failed to produce SECRETENV_BUNDLE from $ENV_FILE.${NC}" >&2
    echo -e "${RED}Re-run with: SECRETENV_KEY=\$SECRETENV_KEY npx -y -p github:rjp44/secretenv#v1.0.5 secretenv -p '$ENV_FILE' -e${NC}" >&2
    exit 1
fi
SECRETENV_BUNDLE="${BUNDLE_LINE#SECRETENV_BUNDLE=}"

if [ "$DRY_RUN" = 1 ]; then
    echo -e "${GREEN}Bundle generated (${#SECRETENV_BUNDLE} chars). Dry-run — not publishing.${NC}"
    unset SECRETENV_KEY SECRETENV_BUNDLE
    exit 0
fi

# ---- Publish: GCP Secret Manager --------------------------------------------

publish_gcp() {
    local key_name="SECRETENV_PIPECAT_${ENV_UPPER}_KEY"
    local bundle_name="SECRETENV_PIPECAT_${ENV_UPPER}_BUNDLE"
    local name value
    for pair in "$key_name|$SECRETENV_KEY" "$bundle_name|$SECRETENV_BUNDLE"; do
        name="${pair%%|*}"; value="${pair#*|}"
        if gcloud secrets describe "$name" --project="$PROJECT_ID" >/dev/null 2>&1; then
            echo -e "${YELLOW}  $name exists — adding a new version${NC}"
            printf '%s' "$value" | gcloud secrets versions add "$name" \
                --project="$PROJECT_ID" --data-file=- >/dev/null
        else
            echo -e "${YELLOW}  Creating $name${NC}"
            printf '%s' "$value" | gcloud secrets create "$name" \
                --project="$PROJECT_ID" --replication-policy=automatic \
                --data-file=- >/dev/null
        fi
    done
    echo
    echo -e "${GREEN}Done.${NC} The VM's service account needs ${GREEN}roles/secretmanager.secretAccessor${NC}"
    echo -e "on these secrets (or on the project). If not already granted:"
    echo
    echo -e "  ${YELLOW}for s in $key_name $bundle_name; do${NC}"
    echo -e "  ${YELLOW}  gcloud secrets add-iam-policy-binding \"\$s\" \\${NC}"
    echo -e "  ${YELLOW}    --project=$PROJECT_ID --role=roles/secretmanager.secretAccessor \\${NC}"
    echo -e "  ${YELLOW}    --member=serviceAccount:<VM-service-account>${NC}"
    echo -e "  ${YELLOW}done${NC}"
    echo
    echo -e "Then ensure your .env points at the matching path:"
    echo -e "  ${GREEN}GOOGLE_SECRETENV_PATH=projects/<PROJECT_NUMERIC_ID>/secrets/SECRETENV_PIPECAT_${ENV_UPPER}${NC}"
    echo -e "(The pipecat-worker and esl-poller append _KEY/_BUNDLE at startup.)"
}

# ---- Publish: Kubernetes Secret ---------------------------------------------

publish_k8s() {
    local per_env_name="pipecat-secretenv-${ENVIRONMENT}"
    local alias_name="pipecat-secretenv"

    # Make sure the namespace exists (idempotent).
    if ! kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; then
        echo -e "${YELLOW}  Creating namespace $NAMESPACE${NC}"
        kubectl create namespace "$NAMESPACE" >/dev/null
    fi

    apply_secret() {
        local name="$1"
        # `kubectl create … --dry-run=client -o yaml | kubectl apply -f -` is the
        # canonical idempotent-upsert pattern. --from-literal does briefly expose
        # values to `ps`, but the alternative (a temp file on disk) is worse for
        # the constraint "no secrets on the filesystem". The wrapper exits in
        # well under a second.
        kubectl create secret generic "$name" \
            --namespace="$NAMESPACE" \
            --from-literal=SECRETENV_KEY="$SECRETENV_KEY" \
            --from-literal=SECRETENV_BUNDLE="$SECRETENV_BUNDLE" \
            --dry-run=client -o yaml | kubectl apply -f - >/dev/null
        # Label so it's obvious which env the secret belongs to.
        kubectl label secret "$name" --namespace="$NAMESPACE" --overwrite \
            app.kubernetes.io/name=pipecat-agent \
            aplisay.com/pipecat-env="$ENVIRONMENT" >/dev/null
    }
    echo -e "${YELLOW}  Writing $per_env_name (history)${NC}"
    apply_secret "$per_env_name"
    echo -e "${YELLOW}  Writing $alias_name (active — the name the overlays envFrom)${NC}"
    apply_secret "$alias_name"

    echo
    echo -e "${GREEN}Done.${NC} The overlays' envFrom resolves $alias_name; you don't need to change anything in kustomize."
    echo -e "Per-env copies ($per_env_name) are retained so you can roll back with:"
    echo -e "  ${YELLOW}kubectl get secret $per_env_name -n $NAMESPACE -o yaml \\${NC}"
    echo -e "  ${YELLOW}  | sed 's/$per_env_name/$alias_name/' | kubectl apply -f -${NC}"
    echo
    echo -e "If your DaemonSet pods are already running, restart them to pick up the new env:"
    echo -e "  ${YELLOW}kubectl rollout restart daemonset/pipecat-sip -n $NAMESPACE${NC}"
}

case "$BACKEND" in
    gcp) publish_gcp ;;
    k8s) publish_k8s ;;
esac

# Best-effort scrub: clear our shell variables.
unset SECRETENV_KEY SECRETENV_BUNDLE BUNDLE_LINE
