#!/bin/sh
# detect-external-ip.sh — discover this node's public IPv4 and write it to a file
# the SIP/media gateway reads at startup. The gateway advertises this address in
# SDP (c=/m=) so SBCs send RTP media straight at the node. Getting this wrong
# means one-way or no audio, so we fail loudly rather than guess.
#
# Detection order (first hit wins):
#   1. NODE_EXT_IP            operator-pinned override (set in the ConfigMap)
#   2. GCP   instance metadata server
#   3. AWS   IMDSv2 (token + public-ipv4)
#   4. DigitalOcean metadata server
#   5. EXT_IP_ECHO_URL        generic HTTPS IP-echo fallback (works anywhere with
#                             egress; default https://checkip.amazonaws.com)
#
# Runs in the `detect-ip` initContainer (image: curlimages/curl). POSIX sh only.
#
# Usage: detect-external-ip.sh [OUTPUT_FILE]   (default /etc/node-meta/ext-ip)
set -eu

OUT="${1:-${OUT:-/etc/node-meta/ext-ip}}"
ECHO_URL="${EXT_IP_ECHO_URL:-https://checkip.amazonaws.com}"

is_ipv4() {
    echo "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'
}

detect() {
    ip=""

    # 1. Operator override. A set-but-malformed value is a typo we must not
    #    paper over by silently auto-detecting a different address.
    if [ -n "${NODE_EXT_IP:-}" ]; then
        if is_ipv4 "$NODE_EXT_IP"; then
            echo "$NODE_EXT_IP"
            return 0
        fi
        echo "detect-external-ip: NODE_EXT_IP='${NODE_EXT_IP}' is not a valid IPv4" >&2
        return 1
    fi

    # 2. GCP. metadata.google.internal only resolves on GCE; the short timeout
    #    keeps the miss fast on other clouds.
    ip=$(curl -fsS --max-time 3 -H 'Metadata-Flavor: Google' \
        'http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip' \
        2>/dev/null || true)
    if is_ipv4 "$ip"; then echo "$ip"; return 0; fi

    # 3. AWS IMDSv2. The PUT for a session token only succeeds on EC2; DO's
    #    metadata server (same 169.254.169.254) has no /latest/api/token so the
    #    token comes back empty and we fall through to the DO probe below.
    token=$(curl -fsS --max-time 3 -X PUT \
        -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' \
        'http://169.254.169.254/latest/api/token' 2>/dev/null || true)
    if [ -n "$token" ]; then
        ip=$(curl -fsS --max-time 3 -H "X-aws-ec2-metadata-token: $token" \
            'http://169.254.169.254/latest/meta-data/public-ipv4' 2>/dev/null || true)
        if is_ipv4 "$ip"; then echo "$ip"; return 0; fi
    fi

    # 4. DigitalOcean.
    ip=$(curl -fsS --max-time 3 \
        'http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address' \
        2>/dev/null || true)
    if is_ipv4 "$ip"; then echo "$ip"; return 0; fi

    # 5. Generic HTTPS IP echo (last resort). Reports the egress IP, which is the
    #    node's public IP on a 1:1-NAT cloud VM but NOT behind a SNAT gateway —
    #    pin NODE_EXT_IP in that case.
    ip=$(curl -fsS --max-time 5 "$ECHO_URL" 2>/dev/null | tr -d '[:space:]' || true)
    if is_ipv4 "$ip"; then echo "$ip"; return 0; fi

    return 1
}

if ip=$(detect); then
    printf '%s' "$ip" > "$OUT"
    echo "detect-external-ip: node external IP = $ip (written to $OUT)" >&2
else
    echo "detect-external-ip: FAILED to determine node external IP." >&2
    echo "  Set NODE_EXT_IP in the pipecat-config ConfigMap, or ensure a cloud" >&2
    echo "  metadata server or ${ECHO_URL} is reachable from the node." >&2
    exit 1
fi
