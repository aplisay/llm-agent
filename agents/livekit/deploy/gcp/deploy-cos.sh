#!/bin/bash
set -euo pipefail

# Deploy the Aplisay LiveKit agent to one or more GCP VMs running Container-
# Optimized OS (COS), with the SAME docker-compose.yaml and .env that
# deploy-node.sh ships to the Debian/Ubuntu nodes.
#
# Why this exists: the konlet runners this stack replaces ran on COS and appear
# to use noticeably less CPU than the compose runners on Debian/Ubuntu. Running
# the identical compose spec on COS isolates the OS as a variable — everything
# below is deliberately built so the container's runtime configuration (image,
# env, network mode, log driver, stop grace) is byte-identical to the
# Debian/Ubuntu deployment, and only the host OS differs.
#
# COS is not Debian. Four things had to change from deploy-node.sh:
#
#   1. No apt, no Docker install. Docker is preinstalled and enabled; if it is
#      missing this is not a COS image and the script stops.
#   2. No gcloud on the VM. Artifact Registry auth takes its OAuth token
#      straight from the metadata server, and the Secret Manager readability
#      check is a REST call whose HTTP status is all we look at — the payload
#      is never fetched into a shell variable, let alone written down.
#   3. No docker compose plugin. It is installed to /var/lib/aplisay-compose/bin
#      and made executable with the documented COS bind-mount + remount-exec
#      workaround (COS mounts /var noexec), with a systemd unit to re-apply the
#      mount after a reboot. The binary is symlinked into ~/.docker/cli-plugins
#      so plain `docker compose` works, and so log.sh/status.sh keep working.
#   4. Docker may need sudo. Every remote block detects that once and routes
#      through DK with DOCKER_CONFIG pinned to the login user's home, so the
#      registry auth and the plugin symlink are found either way.
#
# Secrets behave exactly as in deploy-node.sh: they never touch any filesystem.
# The image's own entrypoint reads SECRETENV_KEY/_BUNDLE from Secret Manager at
# container start with the VM's service account. This script only points at
# them (GOOGLE_SECRETENV_PATH) and checks the VM can read them.
#
# Node list is remembered in .last-deployment-cos — deliberately NOT the
# .last-deployment that deploy-node.sh writes and that _common.sh (log.sh,
# status.sh, upgrade.sh) reads, so a COS run cannot silently repoint the
# helpers at the wrong fleet. To use the helpers against a COS node, pass it
# explicitly:  NODES=livekit-cos-staging:europe-west2-b ./log.sh
# (upgrade.sh is the exception: it shells out to gcloud on the VM and will not
# work on COS. Re-run this script instead — it is idempotent.)
#
# Usage:
#   ./deploy-cos.sh [--env=<staging|production>] [--nodes=<list>] [--zone=<zone>]
#                   [--components=<list>] [--mirror=<instance[:zone]>]
#                   [--cos-image-family=<family>] [--yes]
#
#   --components   Comma-separated subset, or "all"
#                  (default = compose,docker,secrets,parity)
#                  compose  install the docker compose plugin on the COS node
#                  docker   env + compose file + registry auth + pull/up
#                  secrets  verify the VM can read the pair, then recreate the
#                           container so it re-fetches (use after a rotation)
#                  parity   print the OS/CPU/container facts worth diffing
#                           against the Debian node (read-only)
#                  create   NOT part of "all" — opt in explicitly. Provision a
#                           COS VM mirroring --mirror's machine type, service
#                           account, scopes, subnet, tags and boot disk, so the
#                           two sides of the comparison match.
#                  konlet   NOT part of "all" — opt in explicitly. One-shot
#                           migration off the old konlet container declaration
#                           on an existing COS runner.
#
# Examples:
#   ./deploy-cos.sh --env=staging --nodes=livekit-cos-staging --zone=europe-west2-b
#   ./deploy-cos.sh --components=create --nodes=livekit-cos-staging \
#       --zone=europe-west2-b --mirror=agent-runner-staging:europe-west2-b
#   ./deploy-cos.sh --components=parity
#   ./deploy-cos.sh --components=konlet    # convert an existing konlet runner

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

REMOTE_DIR="livekit-agent"

# Pinned only as the fallback when GitHub cannot be asked for the current tag
# (rate limit, egress policy). Any v2 parses this compose file.
COMPOSE_FALLBACK_VERSION="v2.29.7"

ENVIRONMENT=""
NODES_SPEC=""
DEFAULT_ZONE=""
COMPONENTS_SPEC="all"
MIRROR_SPEC=""
COS_IMAGE_FAMILY="cos-stable"
ASSUME_YES=0

while [ $# -gt 0 ]; do
    case "$1" in
        --env=*)        ENVIRONMENT="${1#*=}"; shift ;;
        --env)          ENVIRONMENT="${2:-}"; shift 2 ;;
        --nodes=*)      NODES_SPEC="${1#*=}"; shift ;;
        --nodes)        NODES_SPEC="${2:-}"; shift 2 ;;
        --zone=*)       DEFAULT_ZONE="${1#*=}"; shift ;;
        --zone)         DEFAULT_ZONE="${2:-}"; shift 2 ;;
        --mirror=*)     MIRROR_SPEC="${1#*=}"; shift ;;
        --mirror)       MIRROR_SPEC="${2:-}"; shift 2 ;;
        --cos-image-family=*) COS_IMAGE_FAMILY="${1#*=}"; shift ;;
        --cos-image-family)   COS_IMAGE_FAMILY="${2:-}"; shift 2 ;;
        --components=*) COMPONENTS_SPEC="${1#*=}"; shift ;;
        --components)
            COMPONENTS_SPEC="${2:-}"
            if [ -z "$COMPONENTS_SPEC" ]; then
                echo -e "${RED}Error: --components requires a value (e.g. all or docker,secrets)${NC}" >&2
                exit 1
            fi
            shift 2
            ;;
        --yes|-y)       ASSUME_YES=1; shift ;;
        -h|--help)
            sed -n '4,71p' "$0" | sed 's/^# \{0,1\}//'
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
            compose | docker | secrets | parity | create | konlet) ;;
            *)
                echo -e "${RED}Error: unknown component \"$c\" (allowed: all, compose, docker, secrets, parity, create, konlet)${NC}" >&2
                exit 1
                ;;
        esac
    done
    IFS=$OIFS
fi

# "all" is compose + docker + secrets + parity. create and konlet both change
# state that is awkward to undo, so neither is ever implicit.
wants_component() {
    local name="$1"
    if [ "$COMPONENTS_CSV" = "all" ]; then
        case "$name" in
            create | konlet) return 1 ;;
        esac
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

LAST_VALUES_FILE="$SCRIPT_DIR/.last-deployment-cos"

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

echo -e "${GREEN}=== Aplisay LiveKit Agent — COS Node Deployment ===${NC}\n"
echo -e "Components: ${YELLOW}${COMPONENTS_SPEC}${NC}\n"

if [ -z "$ENVIRONMENT" ]; then
    ENVIRONMENT=$(prompt_input "Deploy to staging or production?" "${LAST_ENVIRONMENT:-staging}")
fi
if [ "$ENVIRONMENT" != "staging" ] && [ "$ENVIRONMENT" != "production" ]; then
    echo -e "${RED}Error: Environment must be 'staging' or 'production'${NC}" >&2
    exit 1
fi

if [ -z "$NODES_SPEC" ]; then
    NODES_SPEC=$(prompt_input "COS VM instance name(s), comma separated (name or name:zone)" "${LAST_NODES:-}")
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

sed_inplace() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "$@"
    else
        sed -i "$@"
    fi
}

# ---- Local file prep ---------------------------------------------------------
#
# Byte-identical to deploy-node.sh on purpose: the whole point of this script is
# that the COS node and the Debian node receive the same two files. Any drift
# here invalidates the comparison.

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

MIRROR_NAME=""
MIRROR_ZONE=""
if wants_component create; then
    if [ -z "$MIRROR_SPEC" ]; then
        echo -e "${RED}Error: --components=create needs --mirror=<instance[:zone]> — the existing${NC}" >&2
        echo -e "${RED}Debian/Ubuntu runner whose shape the COS node should match.${NC}" >&2
        exit 1
    fi
    case "$MIRROR_SPEC" in
        *:*) MIRROR_NAME="${MIRROR_SPEC%%:*}"; MIRROR_ZONE="${MIRROR_SPEC#*:}" ;;
        *)   MIRROR_NAME="$MIRROR_SPEC";       MIRROR_ZONE="$DEFAULT_ZONE" ;;
    esac
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
if wants_component create; then
    echo -e "\n  ${YELLOW}create is enabled:${NC} any node above that does not exist will be"
    echo -e "  ${YELLOW}provisioned on image family ${GREEN}$COS_IMAGE_FAMILY${YELLOW} (cos-cloud), shaped after${NC}"
    echo -e "  ${YELLOW}${GREEN}$MIRROR_NAME${YELLOW} ($MIRROR_ZONE).${NC}"
fi
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

# ---- Remote plumbing ---------------------------------------------------------
#
# Every remote block is prefixed with this preamble. It solves the two COS
# facts that the Debian script never has to think about: docker may need sudo,
# and there is no gcloud to mint an OAuth token.

IFS='' read -r -d '' REMOTE_PREAMBLE <<'PREAMBLE' || true
set -euo pipefail

export DOCKER_CONFIG="$HOME/.docker"
mkdir -p "$DOCKER_CONFIG/cli-plugins"

# COS may or may not put the login user in the docker group depending on image
# milestone and how the VM was created. Detect once and route every docker
# call through DK. A function, not a string: sudo needs DOCKER_CONFIG carried
# across explicitly (it resets the environment), and a string would word-split
# on any path containing a space.
if docker info >/dev/null 2>&1; then
    DK() { docker "$@"; }
else
    DK() { sudo env DOCKER_CONFIG="$DOCKER_CONFIG" docker "$@"; }
fi

COMPOSE_BIN_DIR=/var/lib/aplisay-compose/bin

# The VM's own service account token, straight from the metadata server. This
# is what `gcloud auth print-access-token` returns on the Debian nodes; COS has
# no gcloud, so we ask the same source directly.
metadata_token() {
    curl -s -H 'Metadata-Flavor: Google' \
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token' \
        | sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}
PREAMBLE

# remote_script "<body>" [NAME=value ...] -> full remote script text
# Locals are injected as %q-quoted assignments rather than interpolated into
# the body, which keeps the bodies readable and immune to quoting accidents.
remote_script() {
    local body="$1"; shift
    local assigns="" kv
    for kv in "$@"; do
        assigns+="${kv%%=*}=$(printf '%q' "${kv#*=}")"$'\n'
    done
    printf '%s\n%s%s\n' "$REMOTE_PREAMBLE" "$assigns" "$body"
}

ssh_node() {
    local node="$1" zone="$2" cmd="$3"
    gcloud compute ssh "$node" --zone="$zone" --project="$PROJECT_ID" --command="$cmd"
}

# ---- Remote bodies -----------------------------------------------------------

IFS='' read -r -d '' BODY_CHECK_HOST <<'BODY' || true
if ! command -v docker >/dev/null 2>&1; then
    echo "FATAL: docker not found. COS ships Docker preinstalled — this does not look"
    echo "       like a Container-Optimized OS image. Use deploy-node.sh instead."
    exit 1
fi
if ! grep -qE '^ID=cos' /etc/os-release 2>/dev/null; then
    echo "WARNING: /etc/os-release does not identify as COS:"
    grep -E '^(ID|VERSION|PRETTY_NAME)=' /etc/os-release 2>/dev/null | sed 's/^/  /' || true
fi
echo "  $(grep -E '^PRETTY_NAME=' /etc/os-release 2>/dev/null | cut -d'"' -f2 || echo 'unknown OS')"
echo "  docker $(DK version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"
if docker info >/dev/null 2>&1; then
    echo "  the login user is in the docker group"
else
    echo "  the login user is NOT in the docker group — docker calls go via sudo"
fi
BODY

IFS='' read -r -d '' BODY_INSTALL_COMPOSE <<'BODY' || true
if DK compose version >/dev/null 2>&1; then
    echo "  docker compose already usable: $(DK compose version --short 2>/dev/null || echo unknown)"
    exit 0
fi

sudo mkdir -p "$COMPOSE_BIN_DIR"

# COS mounts /var noexec. Bind-mount the directory onto itself and remount it
# exec — the documented COS workaround. Tested functionally rather than by
# parsing /proc/mounts, so a re-run neither stacks mounts nor guesses wrong.
exec_ok() {
    local t="$COMPOSE_BIN_DIR/.exectest"
    printf '#!/bin/sh\nexit 0\n' | sudo tee "$t" >/dev/null 2>&1 || return 1
    sudo chmod 0755 "$t" || return 1
    if "$t" >/dev/null 2>&1; then sudo rm -f "$t"; return 0; fi
    sudo rm -f "$t"
    return 1
}

if ! exec_ok; then
    echo "  making $COMPOSE_BIN_DIR executable (bind + remount,exec)"
    sudo mount --bind "$COMPOSE_BIN_DIR" "$COMPOSE_BIN_DIR"
    sudo mount -o remount,exec "$COMPOSE_BIN_DIR"
    exec_ok || { echo "FATAL: $COMPOSE_BIN_DIR is still noexec"; exit 1; }
fi

if [ ! -x "$COMPOSE_BIN_DIR/docker-compose" ]; then
    case "$(uname -m)" in
        x86_64)  CARCH=x86_64 ;;
        aarch64) CARCH=aarch64 ;;
        *) echo "FATAL: unsupported architecture $(uname -m)"; exit 1 ;;
    esac

    # Resolve the current tag from the release redirect rather than the GitHub
    # API — no rate limit to trip over. Falls back to the pinned version.
    TAG=$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
            https://github.com/docker/compose/releases/latest 2>/dev/null \
          | sed 's#.*/tag/##') || TAG=""
    case "$TAG" in
        v2.*) ;;
        *) TAG="$COMPOSE_FALLBACK" ;;
    esac

    echo "  installing docker compose $TAG ($CARCH)"
    curl -fsSL -o /tmp/docker-compose \
        "https://github.com/docker/compose/releases/download/$TAG/docker-compose-linux-$CARCH"
    sudo cp /tmp/docker-compose "$COMPOSE_BIN_DIR/docker-compose"
    sudo chmod 0755 "$COMPOSE_BIN_DIR/docker-compose"
    rm -f /tmp/docker-compose
fi

# Docker's own plugin directories are on the read-only root filesystem, so the
# plugin is picked up from the user's config dir. noexec on /home does not
# matter: the symlink resolves to the exec-mounted inode.
ln -sf "$COMPOSE_BIN_DIR/docker-compose" "$DOCKER_CONFIG/cli-plugins/docker-compose"

# /var/lib survives a reboot but the exec remount does not, and COS reboots
# itself for automatic updates. Re-apply the mount at boot.
sudo tee /etc/systemd/system/aplisay-compose-exec.service >/dev/null <<UNIT
[Unit]
Description=exec bind-mount for the docker compose plugin (COS mounts /var noexec)
After=local-fs.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'mount --bind $COMPOSE_BIN_DIR $COMPOSE_BIN_DIR && mount -o remount,exec $COMPOSE_BIN_DIR'

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable aplisay-compose-exec.service >/dev/null 2>&1 || \
    echo "  WARNING: could not enable aplisay-compose-exec.service — re-run this script after a reboot"

echo "  docker compose $(DK compose version --short 2>/dev/null || echo '(version unknown)') installed"
BODY

IFS='' read -r -d '' BODY_AUTH <<'BODY' || true
TOKEN=$(metadata_token || true)
if [ -z "$TOKEN" ]; then
    echo "FATAL: the metadata server returned no access token. Check the VM has a"
    echo "       service account attached with the cloud-platform scope."
    exit 1
fi
printf '%s' "$TOKEN" | DK login -u oauth2accesstoken --password-stdin "https://$IMAGE_REGISTRY" >/dev/null
echo "  docker authenticated to $IMAGE_REGISTRY"
BODY

# Only the HTTP status is inspected. The response body — which is the secret —
# is discarded by curl before it ever reaches a shell variable.
IFS='' read -r -d '' BODY_SECRETS <<'BODY' || true
TOKEN=$(metadata_token || true)
if [ -z "$TOKEN" ]; then
    echo "FATAL: no access token from the metadata server"
    exit 1
fi
for s in "${SECRET_BASE}_KEY" "${SECRET_BASE}_BUNDLE"; do
    code=$(curl -s -o /dev/null -w '%{http_code}' \
        -H "Authorization: Bearer $TOKEN" \
        "https://secretmanager.googleapis.com/v1/projects/$PROJECT_ID/secrets/$s/versions/latest:access")
    if [ "$code" != "200" ]; then
        echo "  $s NOT readable (HTTP $code)"
        exit 1
    fi
    echo "  $s readable"
done
BODY

IFS='' read -r -d '' BODY_PREP_DIR <<'BODY' || true
mkdir -p "$HOME/$REMOTE_DIR"
rm -f "$HOME/$REMOTE_DIR/.env.secretenv"
BODY

IFS='' read -r -d '' BODY_KONLET <<'BODY' || true
set -uo pipefail
if systemctl list-unit-files | grep -q '^konlet-startup'; then
    sudo systemctl stop konlet-startup 2>/dev/null || true
    sudo systemctl disable konlet-startup 2>/dev/null || true
    echo "  konlet-startup stopped and disabled"
else
    echo "  no konlet-startup unit on this host"
fi
for c in $(DK ps -a --filter 'name=^klt-' --format '{{.Names}}'); do
    echo "  removing konlet container $c"
    DK rm -f "$c" >/dev/null || true
done
BODY

IFS='' read -r -d '' BODY_UP <<'BODY' || true
cd "$HOME/$REMOTE_DIR"
DK compose pull 2>&1 || echo "  WARNING: pull failed, continuing with the local image"
# --force-recreate so a re-run restarts the container even when the image
# digest has not moved — that restart is what makes the entrypoint re-read a
# rotated bundle from Secret Manager.
DK compose up -d --force-recreate --remove-orphans 2>&1
BODY

# Read-only. These are the facts that actually differ between a COS host and a
# Debian/Ubuntu host running the same container, in the order they are worth
# suspecting when the CPU numbers disagree.
IFS='' read -r -d '' BODY_PARITY <<'BODY' || true
set -uo pipefail
. /etc/os-release 2>/dev/null || true
echo "  os          ${PRETTY_NAME:-unknown}"
echo "  kernel      $(uname -r)"
echo "  vcpus       $(nproc)"
echo "  cpu         $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ *//')"
echo "  cgroup      $(stat -fc %T /sys/fs/cgroup 2>/dev/null || echo unknown)"
echo "  swap        $(awk 'NR==2{print $1}' /proc/swaps 2>/dev/null || echo none)"
echo "  mitigations $(grep -h . /sys/devices/system/cpu/vulnerabilities/* 2>/dev/null | grep -c -i 'mitigation') of $(ls -1 /sys/devices/system/cpu/vulnerabilities/ 2>/dev/null | wc -l | tr -d ' ') mitigated"
echo "  docker      $(DK version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"
echo "  host load   $(cut -d' ' -f1-3 /proc/loadavg)"
echo "  container   $(DK inspect livekit-agent \
                        --format 'state={{.State.Status}} net={{.HostConfig.NetworkMode}} log={{.HostConfig.LogConfig.Type}} cpus={{.HostConfig.NanoCpus}}' \
                        2>/dev/null || echo absent)"
DK exec livekit-agent printenv 2>/dev/null \
    | grep -E '^(NODE_ENV|LOGLEVEL|LOG_LEVEL|NUM_IDLE_PROCESSES|IMAGE_TAG)=' \
    | sort | sed 's/^/  env         /' || true
echo "  procs       $(DK exec livekit-agent sh -c 'ls -1 /proc | grep -cE "^[0-9]+$"' 2>/dev/null || echo n/a) in container"
DK stats --no-stream --format '  stats       cpu={{.CPUPerc}} mem={{.MemUsage}}' livekit-agent 2>/dev/null || true
BODY

# ---- Optional: provision the COS node ----------------------------------------
#
# Mirrors the reference instance so the only intended difference between the
# two VMs is the boot image. Guest logging and monitoring agents are switched
# off: the COS logging agent is itself a measurable CPU consumer, and the
# hypervisor-level CPU metric that the comparison relies on is collected
# outside the guest either way.

create_node() {
    local name="$1" zone="$2"

    if gcloud compute instances describe "$name" --zone="$zone" --project="$PROJECT_ID" \
            --format='value(name)' >/dev/null 2>&1; then
        echo -e "${GREEN}  $name already exists — leaving it alone${NC}"
        return 0
    fi

    echo -e "${YELLOW}  reading shape from $MIRROR_NAME ($MIRROR_ZONE)...${NC}"
    local ref=(gcloud compute instances describe "$MIRROR_NAME" --zone="$MIRROR_ZONE" --project="$PROJECT_ID")
    local mtype sa scopes subnet tags has_ext boot_disk disk_size disk_type

    mtype=$("${ref[@]}"  --format='value(machineType.basename())')
    sa=$("${ref[@]}"     --format='value(serviceAccounts[0].email)')
    scopes=$("${ref[@]}" --format='value(serviceAccounts[0].scopes.list())')
    subnet=$("${ref[@]}" --format='value(networkInterfaces[0].subnetwork.basename())')
    tags=$("${ref[@]}"   --format='value(tags.items.list())')
    has_ext=$("${ref[@]}" --format='value(networkInterfaces[0].accessConfigs[0].name)')
    boot_disk=$("${ref[@]}" --format='value(disks[0].source.basename())')

    disk_size=$(gcloud compute disks describe "$boot_disk" --zone="$MIRROR_ZONE" --project="$PROJECT_ID" \
        --format='value(sizeGb)' 2>/dev/null || echo "")
    disk_type=$(gcloud compute disks describe "$boot_disk" --zone="$MIRROR_ZONE" --project="$PROJECT_ID" \
        --format='value(type.basename())' 2>/dev/null || echo "")

    if [ -z "$mtype" ]; then
        echo -e "${RED}  could not read a machine type from $MIRROR_NAME${NC}" >&2
        return 1
    fi

    local args=(
        --zone="$zone" --project="$PROJECT_ID"
        --machine-type="$mtype"
        --image-family="$COS_IMAGE_FAMILY" --image-project=cos-cloud
        --metadata=google-logging-enabled=false,google-monitoring-enabled=false
    )
    [ -n "$sa" ]        && args+=( --service-account="$sa" )
    [ -n "$scopes" ]    && args+=( --scopes="$scopes" )
    [ -n "$subnet" ]    && args+=( --subnet="$subnet" )
    [ -n "$tags" ]      && args+=( --tags="$tags" )
    [ -n "$disk_size" ] && args+=( --boot-disk-size="${disk_size}GB" )
    [ -n "$disk_type" ] && args+=( --boot-disk-type="$disk_type" )
    [ -z "$has_ext" ]   && args+=( --no-address )

    echo -e "${YELLOW}  creating $name: $mtype, $COS_IMAGE_FAMILY, ${disk_size:-default}GB ${disk_type:-default}${NC}"
    gcloud compute instances create "$name" "${args[@]}" || return 1

    # Deliberately no gce-container-declaration metadata: that key is what
    # starts konlet, and this node is meant to be driven by compose.
    echo -e "${YELLOW}  waiting for SSH...${NC}"
    local tries=0
    until gcloud compute ssh "$name" --zone="$zone" --project="$PROJECT_ID" \
            --command="true" >/dev/null 2>&1; do
        tries=$((tries + 1))
        if [ "$tries" -ge 20 ]; then
            echo -e "${RED}  $name did not become reachable over SSH${NC}" >&2
            return 1
        fi
        sleep 15
    done
    echo -e "${GREEN}  $name is up${NC}"
}

# ---- Per-node work -----------------------------------------------------------

for i in "${!NODE_NAMES[@]}"; do
    NODE_NAME="${NODE_NAMES[$i]}"
    ZONE="${NODE_ZONES[$i]}"

    echo -e "\n${GREEN}=== $NODE_NAME ($ZONE) ===${NC}"

    if wants_component create; then
        echo -e "\n${YELLOW}Provisioning COS node...${NC}"
        create_node "$NODE_NAME" "$ZONE" || {
            echo -e "${RED}Error: could not provision $NODE_NAME${NC}" >&2
            exit 1
        }
    fi

    if wants_component compose || wants_component docker; then
        echo -e "\n${YELLOW}Checking host...${NC}"
        ssh_node "$NODE_NAME" "$ZONE" "$(remote_script "$BODY_CHECK_HOST")" || {
            echo -e "${RED}Error: host check failed on $NODE_NAME${NC}" >&2
            exit 1
        }
    fi

    if wants_component docker; then
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
    fi

    if wants_component compose; then
        echo -e "\n${YELLOW}Installing docker compose plugin...${NC}"
        ssh_node "$NODE_NAME" "$ZONE" \
            "$(remote_script "$BODY_INSTALL_COMPOSE" "COMPOSE_FALLBACK=$COMPOSE_FALLBACK_VERSION")" || {
            echo -e "${RED}Error: could not install docker compose on $NODE_NAME${NC}" >&2
            exit 1
        }
    fi

    if wants_component docker; then
        echo -e "\n${YELLOW}Configuring Docker authentication for Artifact Registry...${NC}"
        ssh_node "$NODE_NAME" "$ZONE" \
            "$(remote_script "$BODY_AUTH" "IMAGE_REGISTRY=$IMAGE_REGISTRY")" || {
            echo -e "${RED}Error: Failed to configure Docker authentication on $NODE_NAME${NC}" >&2
            exit 1
        }

        echo -e "\n${YELLOW}Copying files...${NC}"
        ssh_node "$NODE_NAME" "$ZONE" \
            "$(remote_script "$BODY_PREP_DIR" "REMOTE_DIR=$REMOTE_DIR")" || {
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
        # Nothing is installed and nothing is stored: the container fetches the
        # pair itself on every start. This only fails early — with a usable
        # message — if the VM's service account cannot read it.
        echo -e "\n${YELLOW}Checking Secret Manager access to ${SECRET_BASE}_KEY / ${SECRET_BASE}_BUNDLE...${NC}"
        ssh_node "$NODE_NAME" "$ZONE" \
            "$(remote_script "$BODY_SECRETS" "SECRET_BASE=$SECRET_BASE" "PROJECT_ID=$PROJECT_ID")" || {
            echo -e "${RED}Error: $NODE_NAME cannot read the secretenv pair — the container would crash-loop.${NC}" >&2
            echo -e "${YELLOW}Grant its service account roles/secretmanager.secretAccessor:${NC}" >&2
            echo -e "${YELLOW}  for s in ${SECRET_BASE}_KEY ${SECRET_BASE}_BUNDLE; do${NC}" >&2
            echo -e "${YELLOW}    gcloud secrets add-iam-policy-binding \"\$s\" --project=$PROJECT_ID \\\\${NC}" >&2
            echo -e "${YELLOW}      --role=roles/secretmanager.secretAccessor --member=serviceAccount:<VM-service-account>${NC}" >&2
            exit 1
        }
        echo -e "${GREEN}Secret Manager access confirmed (nothing written to the VM)${NC}"
    fi

    if wants_component konlet; then
        echo -e "\n${YELLOW}Migrating off the konlet container declaration...${NC}"
        ssh_node "$NODE_NAME" "$ZONE" "$(remote_script "$BODY_KONLET")" || {
            echo -e "${YELLOW}Warning: konlet teardown reported errors on $NODE_NAME${NC}" >&2
        }
        gcloud compute instances remove-metadata "$NODE_NAME" --zone="$ZONE" --project="$PROJECT_ID" \
            --keys=gce-container-declaration >/dev/null 2>&1 && \
            echo -e "${GREEN}gce-container-declaration metadata removed${NC}" || \
            echo -e "${YELLOW}No gce-container-declaration metadata to remove${NC}"
    fi

    if wants_component docker || wants_component secrets; then
        echo -e "\n${YELLOW}Starting containers...${NC}"
        ssh_node "$NODE_NAME" "$ZONE" \
            "$(remote_script "$BODY_UP" "REMOTE_DIR=$REMOTE_DIR")" || {
            echo -e "${RED}Error: Failed to start containers on $NODE_NAME${NC}" >&2
            exit 1
        }
        echo -e "${GREEN}Stack updated on $NODE_NAME${NC}"
    fi

    if wants_component parity; then
        echo -e "\n${YELLOW}Parity report:${NC}"
        ssh_node "$NODE_NAME" "$ZONE" "$(remote_script "$BODY_PARITY")" || {
            echo -e "${YELLOW}Warning: parity report failed on $NODE_NAME${NC}" >&2
        }
    fi
done

echo -e "\n${GREEN}=== Deployment Complete ===${NC}"
echo -e "Environment: ${GREEN}$ENVIRONMENT${NC}"
for i in "${!NODE_NAMES[@]}"; do
    echo -e "Node: ${GREEN}${NODE_NAMES[$i]}${NC} (${NODE_ZONES[$i]})"
done
echo -e "\nThe helper scripts read .last-deployment (the Debian fleet), not this run."
echo -e "Point them at a COS node explicitly:"
echo -e "  ${YELLOW}NODES=${NODE_NAMES[0]}:${NODE_ZONES[0]} ./status.sh${NC}"
echo -e "  ${YELLOW}NODES=${NODE_NAMES[0]}:${NODE_ZONES[0]} ./log.sh${NC}"
echo -e "Re-run this script to upgrade — upgrade.sh needs gcloud on the VM and"
echo -e "will not work against COS."
echo -e "\nCompare the two hosts:"
echo -e "  ${YELLOW}./deploy-cos.sh --components=parity --yes${NC}"
