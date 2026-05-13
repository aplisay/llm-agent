#!/bin/bash
set -euo pipefail

# Deploy the Aplisay Pipecat agent stack to a GCP VM.
#
# Adapted from aplisay-b2bua/deploy/gcp/deploy-node.sh. The shape is identical
# (env template → .env on VM, docker-compose.gcp.yml → docker-compose.yaml on
# VM, install Docker + auth Artifact Registry, optional APIBAN client install),
# but the secrets generated and the remote directory are different:
#
#   - Remote layout:        ~/pipecat-agent/{.env, docker-compose.yaml}
#   - Secrets generated:    ESL_SECRET, CALL_API_TOKEN, WORKER_EVENT_TOKEN,
#                           PIPECAT_DISPATCH_TOKEN, PIPECAT_JOIN_SECRET
#
# Usage:
#   ./deploy-node.sh [--components=<list>]
#
#   --components   Comma-separated subset, or "all" (default).
#                  Recognized: docker (env, compose, Docker on VM, compose pull/up),
#                              apiban (host APIBAN iptables client only).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

REMOTE_DIR="pipecat-agent"

COMPONENTS_SPEC="all"
while [ $# -gt 0 ]; do
    case "$1" in
        --components=*)
            COMPONENTS_SPEC="${1#*=}"
            shift
            ;;
        --components)
            COMPONENTS_SPEC="${2:-}"
            if [ -z "$COMPONENTS_SPEC" ]; then
                echo -e "${RED}Error: --components requires a value (e.g. all or docker,apiban)${NC}" >&2
                exit 1
            fi
            shift 2
            ;;
        -h|--help)
            head -n 24 "$0" | tail -n +2
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
            docker | apiban) ;;
            *)
                echo -e "${RED}Error: unknown component \"$c\" (allowed: all, docker, apiban)${NC}" >&2
                exit 1
                ;;
        esac
    done
    IFS=$OIFS
fi

wants_component() {
    local name="$1"
    if [ "$COMPONENTS_CSV" = "all" ]; then
        return 0
    fi
    case ",${COMPONENTS_CSV}," in
        *",${name},"*) return 0 ;;
        *) return 1 ;;
    esac
}

generate_random_hex() {
    openssl rand -hex 32
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
LAST_NODE_NAME="$1"
LAST_ZONE="$2"
LAST_ENVIRONMENT="$3"
EOF
}

load_last_values

echo -e "${GREEN}=== Aplisay Pipecat Agent Node Deployment ===${NC}\n"
echo -e "Components: ${YELLOW}${COMPONENTS_SPEC}${NC}\n"

ENVIRONMENT=$(prompt_input "Deploy to staging or production?" "${LAST_ENVIRONMENT:-staging}")
if [ "$ENVIRONMENT" != "staging" ] && [ "$ENVIRONMENT" != "production" ]; then
    echo -e "${RED}Error: Environment must be 'staging' or 'production'${NC}" >&2
    exit 1
fi

NODE_NAME=$(prompt_input "Enter GCP VM instance name" "${LAST_NODE_NAME:-}")
ZONE=$(prompt_input "Enter GCP zone" "${LAST_ZONE:-europe-west1-b}")

save_last_values "$NODE_NAME" "$ZONE" "$ENVIRONMENT"

ENV_FILE="$SCRIPT_DIR/.env.$ENVIRONMENT"
ENV_TEMPLATE="$SCRIPT_DIR/env-example-$ENVIRONMENT"

SED_IN_PLACE="sed -i"
if [[ "$OSTYPE" == "darwin"* ]]; then
    SED_IN_PLACE="sed -i ''"
fi

if wants_component docker; then
    command -v openssl >/dev/null 2>&1 || { echo -e "${RED}Error: openssl is required for the docker component.${NC}" >&2; exit 1; }

    echo -e "\n${YELLOW}Processing environment template for ${ENVIRONMENT}...${NC}"
    if [ ! -f "$ENV_TEMPLATE" ]; then
        echo -e "${RED}Error: Template file not found: $ENV_TEMPLATE${NC}" >&2
        exit 1
    fi

    echo -e "\n${YELLOW}Generating random secrets...${NC}"
    ESL_SECRET=$(generate_random_hex)
    CALL_API_TOKEN=$(generate_random_hex)
    WORKER_EVENT_TOKEN=$(generate_random_hex)
    PIPECAT_DISPATCH_TOKEN=$(generate_random_hex)
    PIPECAT_JOIN_SECRET=$(generate_random_hex)

    # Preserve manually-edited values across re-runs.
    APIBAN_ENV_LINE_BACKUP=""
    SHARED_API_TOKEN_BACKUP=""
    if [ -f "$ENV_FILE" ]; then
        APIBAN_ENV_LINE_BACKUP=$(grep '^APIBAN_KEY=' "$ENV_FILE" 2>/dev/null | tail -n1 || true)
        SHARED_API_TOKEN_BACKUP=$(grep '^SHARED_API_TOKEN=' "$ENV_FILE" 2>/dev/null | tail -n1 || true)
    fi

    cp "$ENV_TEMPLATE" "$ENV_FILE"
    # Substitute one hex value per placeholder, in order.
    for var in ESL_SECRET CALL_API_TOKEN WORKER_EVENT_TOKEN PIPECAT_DISPATCH_TOKEN PIPECAT_JOIN_SECRET; do
        val_var_name="$var"
        val="${!val_var_name}"
        $SED_IN_PLACE "/^${var}=/s|<NEW256bithexstring>|$val|g" "$ENV_FILE"
        echo -e "${GREEN}  ${var} generated${NC}"
    done

    PROJECT_NUMERIC_ID=$(grep "^PROJECT_NUMERIC_ID=" "$ENV_TEMPLATE" | cut -d'=' -f2 || echo "160114196407")
    $SED_IN_PLACE "s|\${PROJECT_NUMERIC_ID}|$PROJECT_NUMERIC_ID|g" "$ENV_FILE"

    # Restore preserved fields when present.
    if [ -n "$APIBAN_ENV_LINE_BACKUP" ]; then
        grep -v '^APIBAN_KEY=' "$ENV_FILE" > "${ENV_FILE}.tmp.$$" && mv "${ENV_FILE}.tmp.$$" "$ENV_FILE"
        printf '%s\n' "$APIBAN_ENV_LINE_BACKUP" >> "$ENV_FILE"
    fi
    if [ -n "$SHARED_API_TOKEN_BACKUP" ]; then
        grep -v '^SHARED_API_TOKEN=' "$ENV_FILE" > "${ENV_FILE}.tmp.$$" && mv "${ENV_FILE}.tmp.$$" "$ENV_FILE"
        printf '%s\n' "$SHARED_API_TOKEN_BACKUP" >> "$ENV_FILE"
    fi

    echo -e "${GREEN}Using env file: $ENV_FILE${NC}"

    echo -e "\n${YELLOW}Creating docker-compose.yaml...${NC}"
    COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yaml"
    COMPOSE_TEMPLATE="$SCRIPT_DIR/docker-compose.gcp.yml"
    if [ ! -f "$COMPOSE_TEMPLATE" ]; then
        echo -e "${RED}Error: Docker compose template not found: $COMPOSE_TEMPLATE${NC}" >&2
        exit 1
    fi
    cp "$COMPOSE_TEMPLATE" "$COMPOSE_FILE"
    echo -e "${GREEN}Created docker-compose.yaml: $COMPOSE_FILE${NC}"
else
    echo -e "\n${YELLOW}Skipping Docker env/compose generation (--components excludes docker).${NC}"
    if [ ! -f "$ENV_FILE" ]; then
        echo -e "${RED}Error: $ENV_FILE not found. Run with --components=docker (or all) once to create it.${NC}" >&2
        exit 1
    fi
    COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yaml"
fi

PROJECT_ID=$(grep "^PROJECT_ID=" "$ENV_FILE" | cut -d'=' -f2 || echo "")
if [ -z "$PROJECT_ID" ]; then
    echo -e "${RED}Error: PROJECT_ID not found in $ENV_FILE${NC}" >&2
    exit 1
fi

echo -e "\n${YELLOW}Ready to deploy to:${NC}"
echo -e "  Environment: ${GREEN}$ENVIRONMENT${NC}"
echo -e "  Components:  ${GREEN}$COMPONENTS_SPEC${NC}"
echo -e "  Node:        ${GREEN}$NODE_NAME${NC}"
echo -e "  Zone:        ${GREEN}$ZONE${NC}"
echo -e "  Project:     ${GREEN}$PROJECT_ID${NC}"
echo -e "  Remote dir:  ${GREEN}~/$REMOTE_DIR${NC}"
if wants_component docker; then
    echo -e "\nFiles for Docker component:"
    echo -e "  - $ENV_FILE (as ~/$REMOTE_DIR/.env on VM)"
    echo -e "  - $COMPOSE_FILE"
fi

read -p "$(echo -e ${YELLOW}Continue with deployment? [y/N]: ${NC})" -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${RED}Deployment cancelled.${NC}"
    exit 0
fi

if wants_component docker; then
    echo -e "\n${YELLOW}Checking Docker installation on VM...${NC}"
    DOCKER_CHECK=$(gcloud compute ssh "$NODE_NAME" --zone="$ZONE" --project="$PROJECT_ID" \
        --command="command -v docker" 2>/dev/null || echo "")

    if [ -z "$DOCKER_CHECK" ]; then
        echo -e "${YELLOW}Docker not found. Installing Docker...${NC}"
        gcloud compute ssh "$NODE_NAME" --zone="$ZONE" --project="$PROJECT_ID" --command="
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
            echo -e "${RED}Error: Failed to install Docker${NC}" >&2
            exit 1
        }
        echo -e "${GREEN}Docker installed successfully${NC}"
    else
        echo -e "${GREEN}Docker is already installed${NC}"
    fi

    echo -e "\n${YELLOW}Checking VM OAuth scopes...${NC}"
    VM_SCOPES=$(gcloud compute instances describe "$NODE_NAME" --zone="$ZONE" --project="$PROJECT_ID" \
        --format="get(serviceAccounts[].scopes[])" 2>/dev/null || echo "")

    if echo "$VM_SCOPES" | grep -q "cloud-platform"; then
        echo -e "${GREEN}✓ VM has cloud-platform scope (required for Secret Manager + AR pull)${NC}"
    else
        echo -e "${YELLOW}⚠ Warning: VM does not have cloud-platform scope${NC}"
        echo -e "${YELLOW}  Current scopes:${NC}"
        echo "$VM_SCOPES" | sed 's/^/    /'
        read -p "Continue anyway? (y/N): " continue_anyway
        if [[ ! "$continue_anyway" =~ ^[Yy]$ ]]; then
            echo -e "${RED}Deployment cancelled${NC}"
            exit 1
        fi
    fi

    echo -e "\n${YELLOW}Configuring Docker authentication for Artifact Registry...${NC}"
    IMAGE_REGISTRY=$(grep "^IMAGE_REGISTRY=" "$ENV_FILE" | cut -d'=' -f2 || echo "europe-west1-docker.pkg.dev")

    gcloud compute ssh "$NODE_NAME" --zone="$ZONE" --project="$PROJECT_ID" --command="
        if ! command -v gcloud &> /dev/null; then
            echo 'Installing gcloud CLI...'
            echo \"deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main\" | sudo tee -a /etc/apt/sources.list.d/google-cloud-sdk.list
            curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo apt-key --keyring /usr/share/keyrings/cloud.google.gpg add -
            sudo apt-get update && sudo apt-get install -y google-cloud-sdk
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
        echo -e "${RED}Error: Failed to configure Docker authentication${NC}" >&2
        exit 1
    }
    echo -e "${GREEN}Docker authentication configured${NC}"

    echo -e "\n${YELLOW}Creating remote directory...${NC}"
    gcloud compute ssh "$NODE_NAME" --zone="$ZONE" --project="$PROJECT_ID" --command="mkdir -p ~/$REMOTE_DIR" || {
        echo -e "${RED}Error: Failed to create remote directory${NC}" >&2
        exit 1
    }

    echo -e "\n${YELLOW}Copying files to VM...${NC}"
    gcloud compute scp "$ENV_FILE" "$NODE_NAME:~/$REMOTE_DIR/.env" --zone="$ZONE" --project="$PROJECT_ID" || {
        echo -e "${RED}Error: Failed to copy .env file${NC}" >&2
        exit 1
    }
    gcloud compute scp "$COMPOSE_FILE" "$NODE_NAME:~/$REMOTE_DIR/docker-compose.yaml" --zone="$ZONE" --project="$PROJECT_ID" || {
        echo -e "${RED}Error: Failed to copy docker-compose.yaml${NC}" >&2
        exit 1
    }
    echo -e "${GREEN}Files copied successfully${NC}"

    echo -e "\n${YELLOW}Fetching external IP address from VM metadata...${NC}"
    EXTERNAL_IP=$(gcloud compute ssh "$NODE_NAME" --zone="$ZONE" --project="$PROJECT_ID" \
        --command="curl -s -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip" 2>/dev/null || echo "")

    if [ -z "$EXTERNAL_IP" ]; then
        echo -e "${YELLOW}Warning: Could not fetch external IP from metadata server${NC}" >&2
    else
        echo -e "${GREEN}External IP address: $EXTERNAL_IP${NC}"
        gcloud compute ssh "$NODE_NAME" --zone="$ZONE" --project="$PROJECT_ID" \
            --command="cd ~/$REMOTE_DIR && sed -i 's|^EXT_IP_ADDRESS=.*|EXT_IP_ADDRESS=$EXTERNAL_IP|' .env && echo 'Updated EXT_IP_ADDRESS in .env file'" || {
            echo -e "${YELLOW}Warning: Failed to update EXT_IP_ADDRESS in .env file on VM${NC}" >&2
        }
    fi

    echo -e "\n${YELLOW}Starting containers on VM...${NC}"
    gcloud compute ssh "$NODE_NAME" --zone="$ZONE" --project="$PROJECT_ID" --command="cd ~/$REMOTE_DIR && docker compose pull 2>&1" || {
        echo -e "${YELLOW}Warning: docker compose pull failed, continuing anyway...${NC}" >&2
    }
    gcloud compute ssh "$NODE_NAME" --zone="$ZONE" --project="$PROJECT_ID" --command="cd ~/$REMOTE_DIR && docker compose up -d 2>&1" || {
        echo -e "${RED}Error: Failed to start containers${NC}" >&2
        exit 1
    }
    echo -e "${GREEN}Docker stack updated${NC}"
else
    echo -e "\n${YELLOW}Skipping Docker install / file copy / compose (not in --components).${NC}"
fi

if wants_component apiban; then
    APIBAN_KEY_LINE=$(grep '^APIBAN_KEY=' "$ENV_FILE" 2>/dev/null | tail -n1 || true)
    APIBAN_KEY="${APIBAN_KEY_LINE#APIBAN_KEY=}"
    APIBAN_KEY="${APIBAN_KEY#\"}"
    APIBAN_KEY="${APIBAN_KEY%\"}"
    APIBAN_KEY="$(printf '%s' "$APIBAN_KEY" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    if [ -z "$APIBAN_KEY" ]; then
        echo -e "\n${YELLOW}APIBAN_KEY is empty in $ENV_FILE.${NC}"
        read -rsp "Enter APIBAN key (from apiban.org), or press Enter to skip: " APIBAN_KEY
        echo
        APIBAN_KEY="$(printf '%s' "$APIBAN_KEY" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
        if [ -n "$APIBAN_KEY" ]; then
            grep -v '^APIBAN_KEY=' "$ENV_FILE" > "${ENV_FILE}.tmp.$$" && mv "${ENV_FILE}.tmp.$$" "$ENV_FILE"
            printf 'APIBAN_KEY=%s\n' "$APIBAN_KEY" >> "$ENV_FILE"
            echo -e "${GREEN}Saved APIBAN_KEY to $ENV_FILE${NC}"
        fi
    fi
    if [ -n "$APIBAN_KEY" ]; then
        echo -e "\n${YELLOW}Installing APIBAN iptables client on VM...${NC}"
        APIBAN_CONFIG_TMP=$(mktemp)
        if command -v jq >/dev/null 2>&1; then
            jq -n --arg k "$APIBAN_KEY" '{apikey: $k, lkid: "100", version: "1.0", set: "sip", flush: "200"}' > "$APIBAN_CONFIG_TMP"
        elif command -v python3 >/dev/null 2>&1; then
            python3 -c 'import json,sys; print(json.dumps({"apikey":sys.argv[1],"lkid":"100","version":"1.0","set":"sip","flush":"200"}))' "$APIBAN_KEY" > "$APIBAN_CONFIG_TMP"
        else
            rm -f "$APIBAN_CONFIG_TMP"
            echo -e "${RED}Error: jq or python3 is required to build APIBAN config.json${NC}" >&2
            exit 1
        fi
        APIBAN_CONFIG_B64="$(base64 < "$APIBAN_CONFIG_TMP" | tr -d '\n')"
        rm -f "$APIBAN_CONFIG_TMP"
        gcloud compute ssh "$NODE_NAME" --zone="$ZONE" --project="$PROJECT_ID" --command="
            set -euo pipefail
            echo '$APIBAN_CONFIG_B64' | base64 -d > \"\$HOME/apiban-config.json\"
            chmod 600 \"\$HOME/apiban-config.json\"
        " || {
            echo -e "${RED}Error: Failed to upload APIBAN config to VM${NC}" >&2
            exit 1
        }
        gcloud compute ssh "$NODE_NAME" --zone="$ZONE" --project="$PROJECT_ID" --command="
            set -euo pipefail
            sudo apt-get install -y -qq iptables curl >/dev/null
            sudo mkdir -p /usr/local/bin/apiban
            sudo curl -fsSL -o /usr/local/bin/apiban/apiban-iptables-client \
                'https://raw.githubusercontent.com/apiban/apiban-client-go/v1.0/apiban-iptables-client'
            sudo chmod +x /usr/local/bin/apiban/apiban-iptables-client
            sudo mv \"\$HOME/apiban-config.json\" /usr/local/bin/apiban/config.json
            sudo chmod 600 /usr/local/bin/apiban/config.json
            sudo tee /etc/logrotate.d/apiban-client > /dev/null <<'APIBAN_LOGROTATE'
/var/log/apiban-client.log {
	daily
	copytruncate
	rotate 7
	compress
}
APIBAN_LOGROTATE
            sudo tee /etc/cron.d/apiban-client > /dev/null <<'APIBAN_CRON'
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin
*/4 * * * * root /usr/local/bin/apiban/apiban-iptables-client >/dev/null 2>&1
APIBAN_CRON
            sudo chmod 644 /etc/cron.d/apiban-client
            sudo /usr/local/bin/apiban/apiban-iptables-client
            echo 'APIBAN client installed and initial sync completed'
        " || {
            echo -e "${RED}Error: APIBAN install failed on VM${NC}" >&2
            exit 1
        }
        echo -e "${GREEN}APIBAN client configured (see /var/log/apiban-client.log on the VM)${NC}"
    else
        echo -e "\n${YELLOW}APIBAN_KEY not set; skipping APIBAN client install.${NC}"
    fi
else
    echo -e "\n${YELLOW}Skipping APIBAN (not in --components).${NC}"
fi

echo -e "\n${GREEN}=== Deployment Complete ===${NC}"
echo -e "Environment: ${GREEN}$ENVIRONMENT${NC}"
echo -e "Node:        ${GREEN}$NODE_NAME${NC}"
echo -e "Zone:        ${GREEN}$ZONE${NC}"
echo -e "\nTo check status, run:"
echo -e "  ${YELLOW}gcloud compute ssh $NODE_NAME --zone=$ZONE --project=$PROJECT_ID --command='cd ~/$REMOTE_DIR && docker compose ps'${NC}"
echo -e "\nTo view logs, run:"
echo -e "  ${YELLOW}gcloud compute ssh $NODE_NAME --zone=$ZONE --project=$PROJECT_ID --command='cd ~/$REMOTE_DIR && docker compose logs -f'${NC}"
