#!/usr/bin/env bash
#
# bundle-secretenv.sh — generate a SECRETENV_KEY + SECRETENV_BUNDLE pair from a
# .env file and publish it for the llm-agent server deploy.
#
# Targets (--target, alias --backend to match the pipecat deploy's bundler):
#   --target=gcp (default)  Google Secret Manager, for Cloud Run. Creates /
#                           versions two secrets per environment, named to match
#                           the Cloud Run --set-secrets wiring (the runtime pair
#                           is SECRETENV_KEY / SECRETENV_BUNDLE):
#                             SECRETENV_{ENV}_KEY
#                             SECRETENV_{ENV}_BUNDLE
#   --target=k8s            Kubernetes Secret `llm-agent-secretenv` (keys
#                           SECRETENV_KEY + SECRETENV_BUNDLE) in namespace
#                           `llm-agent` on the cluster BOUND to the environment
#                           (staging -> AMS3, beta -> LON1; --k8s-context
#                           overrides, and no other env has a binding) — the
#                           pair deploy/k8s/beta mounts via envFrom. Override
#                           with --k8s-secret / --k8s-namespace /
#                           --k8s-deployment (rollout hint only).
#
# Environment (dev / staging / beta / production) chooses:
#   - the source .env file at the repo root (.env / .env.<env>)
#   - the gcp secret-name suffix (DEV / STAGING / BETA / PRODUCTION)
#
# Usage (from the repo root or deploy/):
#   ./bundle-secretenv.sh                       # interactive
#   ./bundle-secretenv.sh --env=staging --yes
#   ./bundle-secretenv.sh --env=beta --target=k8s   # LON1, whatever context is current
#   ./bundle-secretenv.sh --env=production --file=path/to/.env
#   ./bundle-secretenv.sh --dry-run             # plan only, no writes
#
# Requirements:
#   - gcloud (gcp target) / kubectl (k8s target), openssl (key), node (+ npx)
#   - the encryption uses the repo's local `secretenv` (node_modules) when
#     present, so the bundle is wire-identical to what the container decrypts;
#     otherwise it pulls github:rjp44/secretenv via npx.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

ENVIRONMENT=""
ENV_FILE=""
TARGET="gcp"
ASSUME_YES=0
DRY_RUN=0

# k8s target details (defaults match deploy/k8s/beta).
K8S_NAMESPACE="llm-agent"
K8S_SECRET_NAME="llm-agent-secretenv"
# Empty = derive from the environment (see "k8s cluster binding" below); set by
# --k8s-context for a cluster this script knows nothing about.
K8S_CONTEXT=""
K8S_DEPLOYMENT="llm-agent"   # only used in the post-publish rollout hint

while [ $# -gt 0 ]; do
    case "$1" in
        --env=*)     ENVIRONMENT="${1#*=}"; shift ;;
        --env)       ENVIRONMENT="${2:-}"; shift 2 ;;
        --file=*)    ENV_FILE="${1#*=}"; shift ;;
        --file)      ENV_FILE="${2:-}"; shift 2 ;;
        --target=*|--backend=*) TARGET="${1#*=}"; shift ;;
        --target|--backend)     TARGET="${2:-}"; shift 2 ;;
        --k8s-secret=*)    K8S_SECRET_NAME="${1#*=}"; shift ;;
        --k8s-secret)      K8S_SECRET_NAME="${2:-}"; shift 2 ;;
        --k8s-namespace=*) K8S_NAMESPACE="${1#*=}"; shift ;;
        --k8s-namespace)   K8S_NAMESPACE="${2:-}"; shift 2 ;;
        --k8s-deployment=*) K8S_DEPLOYMENT="${1#*=}"; shift ;;
        --k8s-deployment)   K8S_DEPLOYMENT="${2:-}"; shift 2 ;;
        --k8s-context=*)   K8S_CONTEXT="${1#*=}"; shift ;;
        --k8s-context)     K8S_CONTEXT="${2:-}"; shift 2 ;;
        --yes|-y)  ASSUME_YES=1; shift ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help)
            sed -n '2,/^set /p' "$0" | sed -n '/^# /p' | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo -e "${RED}Unknown arg: $1${NC}" >&2; exit 2 ;;
    esac
done

case "$TARGET" in
    gcp|k8s) ;;
    *) echo -e "${RED}Invalid target '$TARGET' (use gcp|k8s)${NC}" >&2; exit 2 ;;
esac

# ---- Environment -------------------------------------------------------------

if [ -z "$ENVIRONMENT" ]; then
    read -p "Environment (dev/staging/production) [staging]: " ENVIRONMENT
    ENVIRONMENT=${ENVIRONMENT:-staging}
fi
case "$ENVIRONMENT" in
    dev|staging|beta|production) ;;
    *) echo -e "${RED}Invalid environment '$ENVIRONMENT' (use dev|staging|beta|production)${NC}" >&2; exit 2 ;;
esac
ENV_UPPER=$(printf '%s' "$ENVIRONMENT" | tr '[:lower:]' '[:upper:]')
SECRET_BASE="SECRETENV_${ENV_UPPER}"

# ---- Source .env (the secrets to bundle) -------------------------------------
#
# Defaults to the repo-root env file (.env / .env.<env>) — that's where the SBC
# secrets (POSTGRES_*, certs, …) live. Override with --file.
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
require openssl
require node
[ "$TARGET" = gcp ] && require gcloud
[ "$TARGET" = k8s ] && require kubectl

# ---- k8s cluster binding -----------------------------------------------------
#
# The k8s target used to publish to whatever `kubectl config current-context`
# happened to be. Every environment writes the SAME Secret name into the SAME
# namespace, so aiming at the wrong cluster fails SILENTLY: the write succeeds,
# the intended cluster keeps its old bundle, and the only symptom is config that
# "didn't take" (2026-08-14: a beta bundle landed on the staging cluster — into a
# namespace with no pods, staging's server being on Cloud Run — while beta
# restarted onto month-old values).
#
# So the environment BINDS the cluster — staging -> AMS3, beta -> LON1 — matched
# by REGION substring against the configured contexts, which survives a cluster
# rebuild (the DOKS id in the context name changes, the region does not). No
# match, or more than one, is a hard error: never a silent fall back to whatever
# context happens to be current. Environments with no binding here must name a
# context explicitly with --k8s-context.

k8s_context_for_env() {
    local pattern matches count
    case "$1" in
        staging) pattern="ams3" ;;
        beta)    pattern="lon1" ;;
        *)
            echo -e "${RED}No cluster is bound to environment '$1'. Pass --k8s-context=<context>.${NC}" >&2
            exit 2
            ;;
    esac
    matches=$(kubectl config get-contexts -o name | grep -- "$pattern" || true)
    count=$(printf '%s\n' "$matches" | grep -c . || true)
    if [ "$count" -ne 1 ]; then
        echo -e "${RED}Expected exactly one kubectl context matching '$pattern' for environment '$1'; found $count.${NC}" >&2
        echo -e "${RED}Configured contexts:${NC}" >&2
        kubectl config get-contexts -o name | sed 's/^/  /' >&2
        echo -e "${RED}Pass --k8s-context=<context> to choose explicitly.${NC}" >&2
        exit 1
    fi
    printf '%s' "$matches"
}

# ---- Target details ----------------------------------------------------------
# gcp: PROJECT_ID from the deploy config (not the secrets source).
# k8s: the context BOUND to the environment above.

PROJECT_ID=""
if [ "$TARGET" = gcp ]; then
    PROJECT_ID="llm-voice"
    for f in "$SCRIPT_DIR/.env.$ENVIRONMENT" "$SCRIPT_DIR/env-example-$ENVIRONMENT"; do
        [ -f "$f" ] || continue
        PROJECT_ID=$(grep -E '^PROJECT_ID=' "$f" | head -1 | cut -d= -f2- | tr -d '[:space:]"'"'"'')
        [ -n "$PROJECT_ID" ] && break
    done
    [ -n "$PROJECT_ID" ] || PROJECT_ID=$(gcloud config get-value project 2>/dev/null || true)
    if [ -z "$PROJECT_ID" ]; then
        echo -e "${RED}Could not determine GCP PROJECT_ID (not in deploy/gcp/.env.$ENVIRONMENT or env-example-$ENVIRONMENT, no gcloud default).${NC}" >&2
        exit 1
    fi
elif [ -n "$K8S_CONTEXT" ]; then
    kubectl config get-contexts -o name | grep -Fxq -- "$K8S_CONTEXT" || {
        echo -e "${RED}kubectl context '$K8S_CONTEXT' is not configured.${NC}" >&2
        exit 1
    }
else
    K8S_CONTEXT=$(k8s_context_for_env "$ENVIRONMENT")
fi

# ---- Plan + confirm ----------------------------------------------------------

echo
echo -e "${YELLOW}Plan:${NC}"
echo -e "  Environment:  ${GREEN}$ENVIRONMENT${NC}"
echo -e "  Source .env:  ${GREEN}$ENV_FILE${NC}"
if [ "$TARGET" = gcp ]; then
    echo -e "  Target:       ${GREEN}GCP Secret Manager${NC} (project ${GREEN}$PROJECT_ID${NC})"
    echo -e "  Secrets:      ${GREEN}${SECRET_BASE}_KEY${NC} + ${GREEN}${SECRET_BASE}_BUNDLE${NC}"
else
    echo -e "  Target:       ${GREEN}Kubernetes${NC} (context ${GREEN}$K8S_CONTEXT${NC})"
    echo -e "  Secret:       ${GREEN}$K8S_SECRET_NAME${NC} in namespace ${GREEN}$K8S_NAMESPACE${NC}"
fi
[ "$DRY_RUN" = 1 ] && echo -e "  Mode:         ${YELLOW}DRY RUN (no writes)${NC}"
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

# ---- Publish -----------------------------------------------------------------

publish_gcp() {
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

    echo
    echo -e "${GREEN}Done.${NC} The service account needs ${GREEN}roles/secretmanager.secretAccessor${NC} on these"
    echo -e "secrets (or on the project). If not already granted:"
    echo
    echo -e "  ${YELLOW}for s in ${SECRET_BASE}_KEY ${SECRET_BASE}_BUNDLE; do${NC}"
    echo -e "  ${YELLOW}  gcloud secrets add-iam-policy-binding \"\$s\" \\${NC}"
    echo -e "  ${YELLOW}    --project=$PROJECT_ID --role=roles/secretmanager.secretAccessor \\${NC}"
    echo -e "  ${YELLOW}    --member=serviceAccount:<run-service-account>${NC}"
    echo -e "  ${YELLOW}done${NC}"
    echo
    echo -e "Cloud Run maps them to the runtime pair via:"
    echo -e "  ${GREEN}--set-secrets=SECRETENV_KEY=${SECRET_BASE}_KEY:latest,SECRETENV_BUNDLE=${SECRET_BASE}_BUNDLE:latest${NC}"
    echo -e "A redeploy (new revision) picks up the new versions."
}

publish_k8s() {
    # EVERY call is --context pinned: an inherited current-context is exactly the
    # foot-gun this script no longer has.
    if ! kubectl --context="$K8S_CONTEXT" get namespace "$K8S_NAMESPACE" >/dev/null 2>&1; then
        echo -e "${YELLOW}  Creating namespace $K8S_NAMESPACE${NC}"
        kubectl --context="$K8S_CONTEXT" create namespace "$K8S_NAMESPACE" >/dev/null
    fi
    echo -e "${YELLOW}  Writing Secret $K8S_SECRET_NAME (namespace $K8S_NAMESPACE, context $K8S_CONTEXT)${NC}"
    kubectl --context="$K8S_CONTEXT" create secret generic "$K8S_SECRET_NAME" -n "$K8S_NAMESPACE" \
        --from-literal=SECRETENV_KEY="$SECRETENV_KEY" \
        --from-literal=SECRETENV_BUNDLE="$SECRETENV_BUNDLE" \
        --dry-run=client -o yaml | kubectl --context="$K8S_CONTEXT" apply -f - >/dev/null
    kubectl --context="$K8S_CONTEXT" annotate secret "$K8S_SECRET_NAME" -n "$K8S_NAMESPACE" --overwrite \
        aplisay.com/llm-agent-env="$ENVIRONMENT" >/dev/null

    echo
    echo -e "${GREEN}Done.${NC} Roll the pods onto the new values:"
    echo -e "  ${YELLOW}kubectl --context=$K8S_CONTEXT rollout restart deployment/$K8S_DEPLOYMENT -n $K8S_NAMESPACE${NC}"
}

if [ "$TARGET" = gcp ]; then publish_gcp; else publish_k8s; fi

unset SECRETENV_KEY SECRETENV_BUNDLE BUNDLE_LINE
