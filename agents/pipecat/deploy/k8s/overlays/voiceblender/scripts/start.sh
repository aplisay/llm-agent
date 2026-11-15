#!/bin/sh
# Start voiceblender with the addresses of the node it runs on. Run with the
# static busybox from the node-meta volume, so it needs nothing of the image.
set -eu
bb=/etc/node-meta/busybox

fail() {
  echo "start: $*" >&2
  exit 1
}

flat() {
  printf '%s' "$1" | "$bb" tr -d '[:space:]'
}

# A /0 range means "any address" to voiceblender, as an empty list does.
no_open_range() {
  case ",$(flat "$2")," in
    */0,*) fail "$1 holds a /0 range: voiceblender would take requests from any address" ;;
  esac
}

sip_list="$(flat "${SIP_ALLOWED_IPS:-}")"
[ -n "$(printf '%s' "$sip_list" | "$bb" tr -d ',')" ] ||
  fail "SIP_ALLOWED_IPS is empty: voiceblender would take calls from any address"
no_open_range SIP_ALLOWED_IPS "$sip_list"
no_open_range ALLOWED_IPS "${ALLOWED_IPS:-}"

[ -n "${HOST_IP:-}" ] || fail "HOST_IP is not set"
ext_file="${EXT_IP_FILE:-/etc/node-meta/ext-ip}"
ext="$("$bb" tr -d '[:space:]' < "$ext_file")" || fail "cannot read $ext_file"
[ -n "$ext" ] || fail "no public address in $ext_file"

# A peer inside SIP_LOCAL_NETS is told the private address. Every other peer
# is told the public one.
export SIP_BIND_IP="$HOST_IP"
export SIP_EXTERNAL_IP="$ext"

# The API has no token, so it listens on the private address only. The node
# itself is always on the list: the worker, the probe and the preStop hook
# come from there.
export HTTP_ADDR="$HOST_IP:${ENGINE_API_PORT:-8080}"
api_list="$(flat "${ALLOWED_IPS:-}")"
export ALLOWED_IPS="${api_list:+$api_list,}$HOST_IP"

# The From host of calls out. An SBC may check it.
if [ -z "${SIP_DOMAIN:-}" ] && [ -n "${PIPECAT_SIP_FROM_DOMAIN:-}" ]; then
  export SIP_DOMAIN="$PIPECAT_SIP_FROM_DOMAIN"
fi

# voiceblender will not start a TLS listener without a certificate.
if [ -n "${SIP_TLS_PORT:-}" ] && [ -z "${SIP_TLS_CERT:-}" ]; then
  for dir in /etc/sip-tls /etc/node-meta/sip-tls; do
    if [ -s "$dir/tls.crt" ] && [ -s "$dir/tls.key" ]; then
      export SIP_TLS_CERT="$dir/tls.crt" SIP_TLS_KEY="$dir/tls.key"
      break
    fi
  done
  [ -n "${SIP_TLS_CERT:-}" ] || fail "SIP_TLS_PORT is set and there is no certificate"
fi

export INSTANCE_ID="${NODE_NAME:-$HOST_IP}"

echo "start: voiceblender on $HOST_IP (public $ext), SIP ${SIP_PORT:-5060}, TLS ${SIP_TLS_PORT:-off} (${SIP_TLS_CERT:-no certificate}), RTP ${RTP_PORT_MIN:-?}-${RTP_PORT_MAX:-?}"
# exec: voiceblender must be process 1 to get the pod's signals.
exec voiceblender
