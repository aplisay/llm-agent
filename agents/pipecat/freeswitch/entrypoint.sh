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

chown -R freeswitch:freeswitch /usr/local/freeswitch/run /usr/local/freeswitch/log /usr/local/freeswitch/db ${CERTS_DIR}
chmod og-rwx -R ${CERTS_DIR} || true

exec gosu freeswitch:freeswitch /usr/local/freeswitch/bin/freeswitch -nonat -c
