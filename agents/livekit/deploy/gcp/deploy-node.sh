#!/bin/bash
set -euo pipefail

# Deploy the Aplisay LiveKit agent to one or more GCP VMs with docker compose.
#
# Same shape as aplisay-sbc/deploy/gcp/deploy-node.sh and
# agents/pipecat/deploy/gcp/deploy-node.sh (env template -> .env on VM,
# docker-compose.gcp.yml -> docker-compose.yaml on VM, install Docker, auth
# Artifact Registry, pull + up), with two differences:
#
#   - Remote layout:  ~/livekit-agent/{.env, docker-compose.yaml} — that is all
#   - Secrets:        NEVER touch a filesystem — not the operator's, not the
#                     VM's, not instance metadata (which is what the konlet
#                     declarations this replaces did). The image's own
#                     entrypoint.sh reads SECRETENV_KEY/_BUNDLE from Secret
#                     Manager at container start, with the VM's service
#                     account, straight into the agent process's environment.
#                     This script only points at them (GOOGLE_SECRETENV_PATH)
#                     and checks the VM can read them.
#
# Multiple nodes: production runs several agent runners across zones, so
# --nodes accepts a comma-separated list and each entry may carry its own zone
# as "name:zone" (falling back to the prompted default zone).
#
# Usage:
#   ./deploy-node.sh [--env=<staging|production>] [--nodes=<list>] [--zone=<zone>]
#                    [--components=<list>] [--yes]
#
#   --components   Comma-separated subset, or "all" (default = docker,secrets).
#                  docker   env + compose + Docker on the VM + pull/up
#                  secrets  verify the VM can read the pair, then recreate the
#                           container so it re-fetches (use after a rotation)
#                  konlet   NOT part of "all" — opt in explicitly. One-shot
#                           migration off the old konlet container
#                           declaration: stops + disables konlet, removes the
#                           klt-* container and the gce-container-declaration
#                           metadata key so the VM stops racing compose.
#
# Examples:
#   ./deploy-node.sh
#   ./deploy-node.sh --env=staging --nodes=agent-runner-staging --zone=europe-west2-b
#   ./deploy-node.sh --env=production \
#       --nodes=agent-runner-production:europe-west1-d,agent-runner-production-be3:europe-west1-d,agent-runner-production-be4:europe-west1-b
#   ./deploy-node.sh --components=secrets      # re-fetch a rotated bundle
#   ./deploy-node.sh --components=konlet       # migration step only

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

REMOTE_DIR="livekit-agent"

ENVIRONMENT=""
NODES_SPEC=""
DEFAULT_ZONE=""
COMPONENTS_SPEC="all"
ASSUME_YES=0

while [ $# -gt 0 ]; do
    case "$1" in
        --env=*)        ENVIRONMENT="${1#*=}"; shift ;;
        --env)          ENVIRONMENT="${2:-}"; shift 2 ;;
        --nodes=*)      NODES_SPEC="${1#*=}"; shift ;;
        --nodes)        NODES_SPEC="${2:-}"; shift 2 ;;
        --zone=*)       DEFAULT_ZONE="${1#*=}"; shift ;;
        --zone)         DEFAULT_ZONE="${2:-}"; shift 2 ;;
        --components=*) COMPONENTS_SPEC="${1#*=}"; shift ;;
        --components)
            COMPONENTS_SPEC="${2:-}"
            if [ -z "$COMPONENTS_SPEC" ]; then
                echo -e "${RED}Error: --components requires a value (e.g. all or docker,secrets)${NC}" >&2
                exit 1
            fi
            shift 2
            ;;
        --local-secrets)
            # Used to read the pair with the operator's credentials and scp it
            # to the VM. The secretenv pair is now fetched by the container at
            # start-up and never written to any disk, so there is nothing to
            # copy; the VM's own service account must be able to read it.
            echo -e "${RED}Error: --local-secrets is gone.${NC}" >&2
            echo "The container now reads Secret Manager itself at start-up. Grant the VM's" >&2
            echo "service account roles/secretmanager.secretAccessor on the pair instead." >&2
            exit 1
            ;;
        --yes|-y)        ASSUME_YES=1; shift ;;
        -h|--help)
            sed -n '4,46p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *)
            echo -e "${RED}Error: unknown option: $1${NC}" >&2
            echo "Use --help for usage." >&2
            exit 1
            ;;
    esac
done

COMPONENTS_CSV=$(printf '%s' "$COMPONENTS_SPEC" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
if [ -z "$COMPONENTS_CSV" ]; then
    echo -e "${RED}Error: empty --components value${NC}" >&2
    exit 1
fi
if [ "$COMPONENTS_CSV" != "all" ]; then
    OIFS=$IFS
    IFS=','
    for c in $COMPONENTS_CSV; do
        case "$c" in
            docker | secrets | konlet) ;;
            *)
                echo -e "${RED}Error: unknown component \"$c\" (allowed: all, docker, secrets, konlet)${NC}" >&2
                exit 1
                ;;
        esac
    done
    IFS=$OIFS
fi

# "all" is docker + secrets. konlet is a one-shot migration and never implicit.
wants_component() {
    local name="$1"
    if [ "$COMPONENTS_CSV" = "all" ]; then
        [ "$name" = "konlet" ] && return 1
        return 0
    fi
    case ",${COMPONENTS_CSV}," in
        *",${name},"*) return 0 ;;
        *) return 1 ;;
    esac
}

prompt_input() {
    local prompt="${1:-}"
    local default="${2:-}"

    if [ -n "$default" ]; then
        read -p "$prompt [$default]: " value
        value="${value:-$default}"
    else
        read -p "$prompt: " value
    fi

    echo "$value"
}

command -v gcloud >/dev/null 2>&1 || { echo -e "${RED}Error: gcloud is required but not installed.${NC}" >&2; exit 1; }

LAST_VALUES_FILE="$SCRIPT_DIR/.last-deployment"

load_last_values() {
    if [ -f "$LAST_VALUES_FILE" ]; then
        # shellcheck disable=SC1090
        source "$LAST_VALUES_FILE"
    fi
}

save_last_values() {
    cat > "$LAST_VALUES_FILE" <<EOF
LAST_NODES="$1"
LAST_ZONE="$2"
LAST_ENVIRONMENT="$3"
EOF
}

load_last_values

echo -e "${GREEN}=== Aplisay LiveKit Agent Node Deployment ===${NC}\n"
echo -e "Components: ${YELLOW}${COMPONENTS_SPEC}${NC}\n"

if [ -z "$ENVIRONMENT" ]; then
    ENVIRONMENT=$(prompt_input "Deploy to staging or production?" "${LAST_ENVIRONMENT:-staging}")
fi
if [ "$ENVIRONMENT" != "staging" ] && [ "$ENVIRONMENT" != "production" ]; then
    echo -e "${RED}Error: Environment must be 'staging' or 'production'${NC}" >&2
    exit 1
fi

if [ -z "$NODES_SPEC" ]; then
    NODES_SPEC=$(prompt_input "GCP VM instance name(s), comma separated (name or name:zone)" "${LAST_NODES:-}")
fi
if [ -z "$NODES_SPEC" ]; then
    echo -e "${RED}Error: at least one instance name is required${NC}" >&2
    exit 1
fi
if [ -z "$DEFAULT_ZONE" ]; then
    DEFAULT_ZONE=$(prompt_input "Default GCP zone (for entries without an explicit :zone)" "${LAST_ZONE:-europe-west1-d}")
fi

save_last_values "$NODES_SPEC" "$DEFAULT_ZONE" "$ENVIRONMENT"

ENV_FILE="$SCRIPT_DIR/.env.$ENVIRONMENT"
ENV_TEMPLATE="$SCRIPT_DIR/env-example-$ENVIRONMENT"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yaml"
COMPOSE_TEMPLATE="$SCRIPT_DIR/docker-compose.gcp.yml"

# BSD sed needs an explicit (empty) backup suffix for -i; GNU sed must not get
# one. Kept as a function rather than the `SED_IN_PLACE="sed -i ''"` string the
# sibling deploy scripts use — that expands to a literal '' argument and leaves
# a junk "<file>''" backup behind on macOS.
sed_inplace() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "$@"
    else
        sed -i "$@"
    fi
}

# ---- Local file prep ---------------------------------------------------------

if wants_component docker; then
    echo -e "\n${YELLOW}Processing environment template for ${ENVIRONMENT}...${NC}"
    if [ ! -f "$ENV_TEMPLATE" ]; then
        echo -e "${RED}Error: Template file not found: $ENV_TEMPLATE${NC}" >&2
        exit 1
    fi

    # Preserve values an operator may have hand-edited between runs.
    TRUNK_ID_BACKUP=""
    if [ -f "$ENV_FILE" ]; then
        TRUNK_ID_BACKUP=$(grep '^APLISAY_OUTBOUND_TRUNK_ID=' "$ENV_FILE" 2>/dev/null | tail -n1 || true)
        # An empty assignment is not worth preserving over the template.
        [ "$TRUNK_ID_BACKUP" = "APLISAY_OUTBOUND_TRUNK_ID=" ] && TRUNK_ID_BACKUP=""
    fi

    cp "$ENV_TEMPLATE" "$ENV_FILE"

    PROJECT_NUMERIC_ID=$(grep "^PROJECT_NUMERIC_ID=" "$ENV_TEMPLATE" | cut -d'=' -f2 || echo "")
    if [ -n "$PROJECT_NUMERIC_ID" ]; then
        sed_inplace "s|\${PROJECT_NUMERIC_ID}|$PROJECT_NUMERIC_ID|g" "$ENV_FILE"
    fi

    if [ -n "$TRUNK_ID_BACKUP" ]; then
        grep -v '^APLISAY_OUTBOUND_TRUNK_ID=' "$ENV_FILE" > "${ENV_FILE}.tmp.$$" && mv "${ENV_FILE}.tmp.$$" "$ENV_FILE"
        printf '%s\n' "$TRUNK_ID_BACKUP" >> "$ENV_FILE"
        echo -e "${GREEN}  preserved $TRUNK_ID_BACKUP${NC}"
    fi

    echo -e "${GREEN}Using env file: $ENV_FILE${NC}"

    echo -e "\n${YELLOW}Creating docker-compose.yaml...${NC}"
    if [ ! -f "$COMPOSE_TEMPLATE" ]; then
        echo -e "${RED}Error: Docker compose template not found: $COMPOSE_TEMPLATE${NC}" >&2
        exit 1
    fi
    cp "$COMPOSE_TEMPLATE" "$COMPOSE_FILE"
    echo -e "${GREEN}Created docker-compose.yaml: $COMPOSE_FILE${NC}"
else
    echo -e "\n${YELLOW}Skipping env/compose generation (--components excludes docker).${NC}"
    if [ ! -f "$ENV_FILE" ]; then
        echo -e "${RED}Error: $ENV_FILE not found. Run with --components=docker (or all) once to create it.${NC}" >&2
        exit 1
    fi
fi

PROJECT_ID=$(grep "^PROJECT_ID=" "$ENV_FILE" | cut -d'=' -f2 || echo "")
if [ -z "$PROJECT_ID" ]; then
    echo -e "${RED}Error: PROJECT_ID not found in $ENV_FILE${NC}" >&2
    exit 1
fi
IMAGE_REGISTRY=$(grep "^IMAGE_REGISTRY=" "$ENV_FILE" | cut -d'=' -f2 || echo "europe-west1-docker.pkg.dev")

# Secret Manager base name: GOOGLE_SECRETENV_PATH is a full resource path
# (projects/<numeric>/secrets/<BASE>); the loaders append _KEY / _BUNDLE. It is
# required unconditionally — compose passes it into the container, and without
# it the entrypoint has nothing to fetch.
SECRETENV_PATH=$(grep "^GOOGLE_SECRETENV_PATH=" "$ENV_FILE" | cut -d'=' -f2- || echo "")
SECRET_BASE="${SECRETENV_PATH##*/}"
if [ -z "$SECRET_BASE" ]; then
    echo -e "${RED}Error: GOOGLE_SECRETENV_PATH not found in $ENV_FILE — the container would start with no secrets.${NC}" >&2
    exit 1
fi

# ---- Node list ---------------------------------------------------------------

NODE_NAMES=()
NODE_ZONES=()
OIFS=$IFS
IFS=','
for entry in $NODES_SPEC; do
    entry=$(printf '%s' "$entry" | tr -d '[:space:]')
    [ -z "$entry" ] && continue
    case "$entry" in
        *:*) NODE_NAMES+=("${entry%%:*}"); NODE_ZONES+=("${entry#*:}") ;;
        *)   NODE_NAMES+=("$entry");       NODE_ZONES+=("$DEFAULT_ZONE") ;;
    esac
done
IFS=$OIFS

if [ "${#NODE_NAMES[@]}" -eq 0 ]; then
    echo -e "${RED}Error: no usable instance names in \"$NODES_SPEC\"${NC}" >&2
    exit 1
fi

echo -e "\n${YELLOW}Ready to deploy:${NC}"
echo -e "  Environment: ${GREEN}$ENVIRONMENT${NC}"
echo -e "  Components:  ${GREEN}$COMPONENTS_SPEC${NC}"
echo -e "  Project:     ${GREEN}$PROJECT_ID${NC}"
echo -e "  Remote dir:  ${GREEN}~/$REMOTE_DIR${NC}"
if wants_component secrets; then
    echo -e "  Secrets:     ${GREEN}${SECRET_BASE}_KEY${NC} + ${GREEN}${SECRET_BASE}_BUNDLE${NC} (read by the container at start-up, never stored)"
fi
echo -e "  Nodes:"
for i in "${!NODE_NAMES[@]}"; do
    echo -e "    - ${GREEN}${NODE_NAMES[$i]}${NC} (${NODE_ZONES[$i]})"
done
if wants_component konlet; then
    echo -e "\n  ${RED}konlet migration is enabled:${NC} the old container declaration will be"
    echo -e "  ${RED}removed and the klt-* container stopped on every node above.${NC}"
fi

if [ "$ASSUME_YES" != 1 ]; then
    read -p "$(echo -e ${YELLOW}Continue? [y/N]: ${NC})" -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo -e "${RED}Deployment cancelled.${NC}"
        exit 0
    fi
fi

# ---- Per-node work -----------------------------------------------------------

ssh_node() {
    local node="$1" zone="$2" cmd="$3"
    gcloud compute ssh "$node" --zone="$zone" --project="$PROJECT_ID" --command="$cmd"
}

for i in "${!NODE_NAMES[@]}"; do
    NODE_NAME="${NODE_NAMES[$i]}"
    ZONE="${NODE_ZONES[$i]}"

    echo -e "\n${GREEN}=== $NODE_NAME ($ZONE) ===${NC}"

    if wants_component docker; then
        echo -e "\n${YELLOW}Checking Docker installation...${NC}"
        DOCKER_CHECK=$(ssh_node "$NODE_NAME" "$ZONE" "command -v docker" 2>/dev/null || echo "")

        if [ -z "$DOCKER_CHECK" ]; then
            echo -e "${YELLOW}Docker not found. Installing Docker...${NC}"
            ssh_node "$NODE_NAME" "$ZONE" "
                sudo apt-get update
                sudo apt-get install -y ca-certificates curl gnupg lsb-release
                sudo mkdir -p /etc/apt/keyrings
                curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
                echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian \$(lsb_release -cs) stable\" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
                sudo apt-get update
                sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
                sudo systemctl start docker
                sudo systemctl enable docker
                if ! groups \$USER | grep -q docker; then
                    sudo usermod -aG docker \$USER
                    echo 'User added to docker group.'
                fi
                echo 'Docker installed successfully'
            " || {
                echo -e "${RED}Error: Failed to install Docker on $NODE_NAME${NC}" >&2
                exit 1
            }
            echo -e "${GREEN}Docker installed${NC}"
        else
            echo -e "${GREEN}Docker is already installed${NC}"
        fi

        echo -e "\n${YELLOW}Checking VM OAuth scopes...${NC}"
        VM_SCOPES=$(gcloud compute instances describe "$NODE_NAME" --zone="$ZONE" --project="$PROJECT_ID" \
            --format="get(serviceAccounts[].scopes[])" 2>/dev/null || echo "")

        if echo "$VM_SCOPES" | grep -q "cloud-platform"; then
            echo -e "${GREEN}✓ cloud-platform scope present (Artifact Registry + Secret Manager)${NC}"
        else
            echo -e "${YELLOW}⚠ VM does not have the cloud-platform scope${NC}"
            echo -e "${YELLOW}  Current scopes:${NC}"
            echo "$VM_SCOPES" | sed 's/^/    /'
            VM_SERVICE_ACCOUNT=$(gcloud compute instances describe "$NODE_NAME" --zone="$ZONE" --project="$PROJECT_ID" \
                --format="get(serviceAccounts[0].email)" 2>/dev/null || echo "")
            echo -e "  ${YELLOW}gcloud compute instances set-service-account $NODE_NAME \\${NC}"
            echo -e "    ${YELLOW}--zone=$ZONE --project=$PROJECT_ID \\${NC}"
            [ -n "$VM_SERVICE_ACCOUNT" ] && \
                echo -e "    ${YELLOW}--service-account=$VM_SERVICE_ACCOUNT \\${NC}"
            echo -e "    ${YELLOW}--scopes=https://www.googleapis.com/auth/cloud-platform${NC}"
            echo -e "  ${YELLOW}(the VM must be stopped to change scopes)${NC}"
            read -p "Continue anyway? (y/N): " continue_anyway
            if [[ ! "$continue_anyway" =~ ^[Yy]$ ]]; then
                echo -e "${RED}Deployment cancelled${NC}"
                exit 1
            fi
        fi

        echo -e "\n${YELLOW}Configuring Docker authentication for Artifact Registry...${NC}"
        ssh_node "$NODE_NAME" "$ZONE" "
            if ! command -v gcloud &> /dev/null; then
                echo 'Installing gcloud CLI...'
                echo \"deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main\" | sudo tee -a /etc/apt/sources.list.d/google-cloud-sdk.list
                curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo apt-key --keyring /usr/share/keyrings/cloud.google.gpg add -
                sudo apt-get update && sudo apt-get install -y google-cloud-sdk
            fi
            if ! groups | grep -q docker; then
                echo 'Adding user to docker group (re-login may be needed)...'
                sudo usermod -aG docker \$USER
            fi
            TOKEN=\$(gcloud auth print-access-token 2>&1)
            if [ -z \"\$TOKEN\" ]; then
                echo 'Error: Failed to get access token from gcloud'
                exit 1
            fi
            echo \"\$TOKEN\" | docker login -u oauth2accesstoken --password-stdin https://${IMAGE_REGISTRY} 2>&1 || {
                echo 'Error: Failed to authenticate Docker'
                exit 1
            }
            echo 'Docker authentication configured'
        " || {
            echo -e "${RED}Error: Failed to configure Docker authentication on $NODE_NAME${NC}" >&2
            exit 1
        }

        echo -e "\n${YELLOW}Copying files...${NC}"
        # Also remove any .env.secretenv left by an earlier revision of this
        # script, which used to write the decryption key to the VM's disk.
        ssh_node "$NODE_NAME" "$ZONE" "mkdir -p ~/$REMOTE_DIR && rm -f ~/$REMOTE_DIR/.env.secretenv" || {
            echo -e "${RED}Error: Failed to create ~/$REMOTE_DIR on $NODE_NAME${NC}" >&2
            exit 1
        }
        gcloud compute scp "$ENV_FILE" "$NODE_NAME:~/$REMOTE_DIR/.env" --zone="$ZONE" --project="$PROJECT_ID" || {
            echo -e "${RED}Error: Failed to copy .env to $NODE_NAME${NC}" >&2
            exit 1
        }
        gcloud compute scp "$COMPOSE_FILE" "$NODE_NAME:~/$REMOTE_DIR/docker-compose.yaml" --zone="$ZONE" --project="$PROJECT_ID" || {
            echo -e "${RED}Error: Failed to copy docker-compose.yaml to $NODE_NAME${NC}" >&2
            exit 1
        }
        echo -e "${GREEN}Files copied${NC}"
    fi

    if wants_component secrets; then
        # Nothing to install: the container fetches the pair itself on every
        # start. All this does is fail early — with a usable message — if the
        # VM's service account cannot read it, rather than leaving a container
        # crash-looping. The values are discarded, never written anywhere.
        echo -e "\n${YELLOW}Checking Secret Manager access to ${SECRET_BASE}_KEY / ${SECRET_BASE}_BUNDLE...${NC}"
        ssh_node "$NODE_NAME" "$ZONE" "
            set -euo pipefail
            for s in '${SECRET_BASE}_KEY' '${SECRET_BASE}_BUNDLE'; do
                n=\$(gcloud secrets versions access latest --secret=\"\$s\" --project='$PROJECT_ID' | wc -c)
                echo \"  \$s readable (\$n bytes)\"
            done
        " || {
            echo -e "${RED}Error: $NODE_NAME cannot read the secretenv pair — the container would crash-loop.${NC}" >&2
            echo -e "${YELLOW}Grant its service account roles/secretmanager.secretAccessor:${NC}" >&2
            echo -e "${YELLOW}  for s in ${SECRET_BASE}_KEY ${SECRET_BASE}_BUNDLE; do${NC}" >&2
            echo -e "${YELLOW}    gcloud secrets add-iam-policy-binding \"\$s\" --project=$PROJECT_ID \\\\${NC}" >&2
            echo -e "${YELLOW}      --role=roles/secretmanager.secretAccessor --member=serviceAccount:<VM-service-account>${NC}" >&2
            echo -e "${YELLOW}  done${NC}" >&2
            exit 1
        }
        echo -e "${GREEN}Secret Manager access confirmed (nothing written to the VM)${NC}"
    fi

    if wants_component konlet; then
        echo -e "\n${YELLOW}Migrating off the konlet container declaration...${NC}"
        ssh_node "$NODE_NAME" "$ZONE" "
            set -uo pipefail
            if systemctl list-unit-files | grep -q '^konlet-startup'; then
                sudo systemctl stop konlet-startup 2>/dev/null || true
                sudo systemctl disable konlet-startup 2>/dev/null || true
                echo 'konlet-startup stopped and disabled'
            else
                echo 'no konlet-startup unit on this host'
            fi
            for c in \$(sudo docker ps -a --filter 'name=^klt-' --format '{{.Names}}'); do
                echo \"removing konlet container \$c\"
                sudo docker rm -f \"\$c\" >/dev/null || true
            done
        " || {
            echo -e "${YELLOW}Warning: konlet teardown reported errors on $NODE_NAME${NC}" >&2
        }
        gcloud compute instances remove-metadata "$NODE_NAME" --zone="$ZONE" --project="$PROJECT_ID" \
            --keys=gce-container-declaration >/dev/null 2>&1 && \
            echo -e "${GREEN}gce-container-declaration metadata removed${NC}" || \
            echo -e "${YELLOW}No gce-container-declaration metadata to remove${NC}"
    fi

    if wants_component docker || wants_component secrets; then
        echo -e "\n${YELLOW}Starting containers...${NC}"
        ssh_node "$NODE_NAME" "$ZONE" "cd ~/$REMOTE_DIR && docker compose pull 2>&1" || {
            echo -e "${YELLOW}Warning: docker compose pull failed on $NODE_NAME, continuing...${NC}" >&2
        }
        # --force-recreate so a re-run restarts the container even when the
        # image digest has not moved — that restart is what makes the
        # entrypoint re-read a rotated bundle from Secret Manager.
        ssh_node "$NODE_NAME" "$ZONE" "cd ~/$REMOTE_DIR && docker compose up -d --force-recreate --remove-orphans 2>&1" || {
            echo -e "${RED}Error: Failed to start containers on $NODE_NAME${NC}" >&2
            exit 1
        }
        echo -e "${GREEN}Stack updated on $NODE_NAME${NC}"
    fi
done

echo -e "\n${GREEN}=== Deployment Complete ===${NC}"
echo -e "Environment: ${GREEN}$ENVIRONMENT${NC}"
for i in "${!NODE_NAMES[@]}"; do
    echo -e "Node: ${GREEN}${NODE_NAMES[$i]}${NC} (${NODE_ZONES[$i]})"
done
echo -e "\nStatus:"
echo -e "  ${YELLOW}./status.sh${NC}"
echo -e "Logs:"
echo -e "  ${YELLOW}./log.sh${NC}"
echo -e "Image-only upgrade (no config change):"
echo -e "  ${YELLOW}./upgrade.sh${NC}"
