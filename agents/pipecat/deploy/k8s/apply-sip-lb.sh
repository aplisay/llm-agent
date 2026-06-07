#!/usr/bin/env bash
#
# apply-sip-lb.sh — render a DO SIP overlay and apply it, pinning the SIP
# LoadBalancer to the reserved IP from the matching .env.<env> file.
#
# kustomize cannot interpolate env vars, so the cloud-digitalocean component
# leaves a ${PIPECAT_SIP_LB_IP} placeholder in the rendered Service. This script
# pulls that ONE value out of agents/pipecat/.env.<env> and runs a SCOPED
# envsubst over the render — scoped so it only touches PIPECAT_SIP_LB_IP and
# leaves the ${...}/$(...) shell expansions in the detect-ip / busybox command
# strings intact. (Sourcing the whole .env into the shell would also work, but
# would needlessly splash every secret into the environment.)
#
# Usage:
#   ./apply-sip-lb.sh                       # --env=staging, overlay do-staging
#   ./apply-sip-lb.sh --env=staging
#   ./apply-sip-lb.sh --env=production --overlay=do-production
#   ./apply-sip-lb.sh --env=staging --dry-run     # print rendered YAML, no apply
#   ./apply-sip-lb.sh --env=staging --file=path/to/.env
#
# If PIPECAT_SIP_LB_IP is missing/empty in the env file, loadBalancerIP renders
# empty and DOKS assigns an ephemeral IP (the prior behaviour) — the script warns
# but does not fail.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

ENVIRONMENT="staging"
OVERLAY=""
ENV_FILE=""
DRY_RUN=0

while [ $# -gt 0 ]; do
    case "$1" in
        --env=*)      ENVIRONMENT="${1#*=}"; shift ;;
        --env)        ENVIRONMENT="${2:-}"; shift 2 ;;
        --overlay=*)  OVERLAY="${1#*=}"; shift ;;
        --overlay)    OVERLAY="${2:-}"; shift 2 ;;
        --file=*)     ENV_FILE="${1#*=}"; shift ;;
        --file)       ENV_FILE="${2:-}"; shift 2 ;;
        --dry-run)    DRY_RUN=1; shift ;;
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

# Overlay defaults to do-<env> (do-staging / do-production); override with --overlay.
[ -n "$OVERLAY" ] || OVERLAY="do-${ENVIRONMENT}"
OVERLAY_DIR="$SCRIPT_DIR/$OVERLAY"
if [ ! -f "$OVERLAY_DIR/kustomization.yaml" ]; then
    echo -e "${RED}No kustomization at $OVERLAY_DIR — pass --overlay=<dir under deploy/k8s>.${NC}" >&2
    exit 2
fi

# Env file lives two levels up at agents/pipecat/.env.<env> (same as bundle-secretenv.sh).
[ -n "$ENV_FILE" ] || ENV_FILE="$SCRIPT_DIR/../../.env.$ENVIRONMENT"
if [ ! -f "$ENV_FILE" ]; then
    echo -e "${RED}Env file not found: $ENV_FILE${NC}" >&2
    echo -e "${RED}Pass --file=<path>, or create it from agents/pipecat/env-example-k8s.${NC}" >&2
    exit 2
fi

# Pull just PIPECAT_SIP_LB_IP out of the env file (last assignment wins; ignore
# commented lines). Not sourced, so no other secret leaks into this shell.
PIPECAT_SIP_LB_IP="$(sed -n 's/^[[:space:]]*PIPECAT_SIP_LB_IP[[:space:]]*=[[:space:]]*//p' "$ENV_FILE" | tail -n1)"
PIPECAT_SIP_LB_IP="${PIPECAT_SIP_LB_IP%\"}"; PIPECAT_SIP_LB_IP="${PIPECAT_SIP_LB_IP#\"}"
export PIPECAT_SIP_LB_IP

if [ -n "$PIPECAT_SIP_LB_IP" ]; then
    echo -e "${GREEN}Pinning SIP LoadBalancer to reserved IP ${PIPECAT_SIP_LB_IP}${NC} (env=$ENVIRONMENT, overlay=$OVERLAY)" >&2
else
    echo -e "${YELLOW}PIPECAT_SIP_LB_IP not set in $ENV_FILE — DOKS will assign an ephemeral IP.${NC}" >&2
fi

# Scoped to the one variable so the embedded shell scripts survive untouched.
render() { kubectl kustomize "$OVERLAY_DIR" | envsubst '${PIPECAT_SIP_LB_IP}'; }

if [ "$DRY_RUN" -eq 1 ]; then
    render
else
    render | kubectl apply -f -
fi
