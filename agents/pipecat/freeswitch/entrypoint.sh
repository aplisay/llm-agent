#!/bin/sh
# Same pattern as aplisay-b2bua: strip the Docker-injected *_PORT_* env vars
# that crash FreeSWITCH's libtinfo on startup.
unset `env | egrep '_PORT_[0-9]+(=|_UDP_|_UDP=|_TCP_|_TCP=)' | sed -e 's/=.*//'`

CERTS_DIR=/usr/local/freeswitch/certs
mkdir -p "${CERTS_DIR}"

# Mounted certs override the baked-in self-signed pair.
if [ -f /certs/tls.crt -a -f /certs/tls.key ]; then
  cat /certs/tls.crt /certs/tls.key > ${CERTS_DIR}/agent.pem
fi

# SIP TLS identity (agent.pem) for the sofia external profile. The external
# profile needs this to bring up its TLS context — required for outbound TLS
# to registration b2buas that use transport=tls (the SBC trunk is plain TCP).
# Mint an ephemeral self-signed pair in dev if none was mounted; with
# tls-verify-policy=none on the profile the peer cert isn't validated either way.
if [ ! -f ${CERTS_DIR}/agent.pem ]; then
  CN="${PIPECAT_SIP_FROM_DOMAIN:-dev.pipecat.aplisay.net}"
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout /tmp/agent-key.pem -out /tmp/agent-cert.pem -subj "/CN=${CN}" >/dev/null 2>&1 \
    && cat /tmp/agent-cert.pem /tmp/agent-key.pem > ${CERTS_DIR}/agent.pem
  rm -f /tmp/agent-key.pem /tmp/agent-cert.pem
fi

chown -R freeswitch:freeswitch /usr/local/freeswitch/run /usr/local/freeswitch/log /usr/local/freeswitch/db ${CERTS_DIR}
chmod og-rwx -R ${CERTS_DIR} || true

# Derive the default-SBC gateway proxy from the platform-wide PIPECAT_SIP_*
# triple (the single source of truth shared with sipbridge). PIPECAT_SIP_OUTBOUND
# is a SIP URI (e.g. "sip:test.sbc.aplisay.net:5060;transport=tcp"); the sofia
# gateway "proxy" param wants the host[:port][;transport=…] without the scheme.
# Exported so vars.xml's env-set can pull it into a FreeSWITCH global var.
export PIPECAT_SBC_PROXY="$(printf '%s' "${PIPECAT_SIP_OUTBOUND}" | sed -E 's#^sips?:##')"

exec gosu freeswitch:freeswitch /usr/local/freeswitch/bin/freeswitch -nonat -c
