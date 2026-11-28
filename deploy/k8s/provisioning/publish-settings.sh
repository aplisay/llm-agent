#!/usr/bin/env bash
#
# publish-settings.sh: write the provisioning service's own settings Secret.
#
# The service gets a bundle of its own, with only the variables it reads.
# It is made from the same environment file as the API server's bundle
# (.env.<env> at the repo root), so the two cannot drift apart.
#
# Usage, from anywhere in the repo:
#   ./deploy/k8s/provisioning/publish-settings.sh --env=staging
#   ./deploy/k8s/provisioning/publish-settings.sh --env=staging --dry-run
#   ./deploy/k8s/provisioning/publish-settings.sh --env=staging --file=/path/to/.env.staging
#
# It writes the Secret `provisioning-secretenv` in the namespace of the
# do-<env> target, on the cluster bound to that environment. Every other
# option is passed on to deploy/bundle-secretenv.sh (--yes, --k8s-context=).
# It prints the names it bundled, never a value.
#
# After it, roll the pod: the Secret is read at start.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Every variable the service takes from the settings file, by its exact name.
# Nothing else of the file reaches the pod.
#   POSTGRES_HOST, _PORT, _USER, _PASSWORD, _DB   the database
#   POSTGRES_CA, _CERT, _KEY, _RO_SERVER_NAME     its TLS: the server's CA, the
#                                                 client certificate and key,
#                                                 the name on the server's
#                                                 certificate
#   CREDENTIALS_KEY       the phone's admin password is made from it
#   PBX_REGISTRAR_DOMAIN  when a phone names another model, its lines are
#   REGSERVER_REGISTRAR     worked out again and a new line takes this name
#   PBX_RELEASE           which phone system features are on
# Not in the list: NODE_ENV and PROV_* (the manifests set them), DB_FORCE_SYNC
# (the pod runs with it unset), the POSTGRES_POOL_* settings (the pod runs
# with the defaults), and every other line of the file. A database setting
# the service comes to read later must be added here by name.
ONLY='POSTGRES_HOST,POSTGRES_PORT,POSTGRES_USER,POSTGRES_PASSWORD,POSTGRES_DB,POSTGRES_CA,POSTGRES_CERT,POSTGRES_KEY,POSTGRES_RO_SERVER_NAME,CREDENTIALS_KEY,PBX_REGISTRAR_DOMAIN,REGSERVER_REGISTRAR,PBX_RELEASE'

ENVIRONMENT=""
ARGS=()
while [ $# -gt 0 ]; do
    case "$1" in
        --env=*) ENVIRONMENT="${1#*=}"; shift ;;
        --env)   ENVIRONMENT="${2:-}"; shift 2 ;;
        --target=*|--backend=*|--target|--backend|--only=*|--only|--k8s-secret=*|--k8s-secret|--k8s-namespace=*|--k8s-namespace|--k8s-deployment=*|--k8s-deployment)
            echo "This script sets $1 itself." >&2; exit 2 ;;
        -h|--help) sed -n '2,/^set /p' "$0" | sed -n '/^# /p' | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) ARGS+=("$1"); shift ;;
    esac
done
[ -n "$ENVIRONMENT" ] || { echo "Give --env=<environment>, for example --env=staging." >&2; exit 2; }

TARGET="$DIR/do-$ENVIRONMENT/kustomization.yaml"
[ -f "$TARGET" ] || { echo "No target for '$ENVIRONMENT' (looked for $TARGET)." >&2; exit 2; }
# The namespace the target deploys into, so the Secret lands beside the pod.
NAMESPACE="$(awk '$1 == "namespace:" { print $2; exit }' "$TARGET")"
[ -n "$NAMESPACE" ] || { echo "$TARGET names no namespace." >&2; exit 2; }

exec "$DIR/../../bundle-secretenv.sh" \
    --env="$ENVIRONMENT" \
    --target=k8s \
    --k8s-namespace="$NAMESPACE" \
    --k8s-secret=provisioning-secretenv \
    --k8s-deployment=provisioning \
    --only="$ONLY" \
    ${ARGS[@]+"${ARGS[@]}"}
