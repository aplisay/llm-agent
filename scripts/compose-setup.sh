#!/bin/sh
# Prepare .env for `docker compose up`: copy environment-example if there is no
# .env, then fill in random secrets and a first API key. Values already set in
# .env are kept, so it is safe to run again. Needs only a POSIX shell.
#
#   scripts/compose-setup.sh
set -eu

cd "$(dirname "$0")/.."
ENV_FILE=.env

if [ ! -f "$ENV_FILE" ]; then
    cp environment-example "$ENV_FILE"
    echo "Created $ENV_FILE from environment-example."
fi

random_hex() {
    od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'
}

# Current non-empty value of $1 in .env, or nothing.
current() {
    grep -E "^$1=." "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true
}

# Set $1 to $2 unless .env already gives it a value.
fill() {
    if [ -z "$(current "$1")" ]; then
        grep -vE "^$1=$" "$ENV_FILE" > "$ENV_FILE.tmp" || true
        printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE.tmp"
        mv "$ENV_FILE.tmp" "$ENV_FILE"
        echo "Set $1."
    fi
}

if ! grep -q "^# Added by scripts/compose-setup.sh" "$ENV_FILE"; then
    printf '\n# Added by scripts/compose-setup.sh. Keep CREDENTIALS_KEY once data exists.\n' >> "$ENV_FILE"
fi
fill BOOTSTRAP_API_KEY "$(random_hex 24)"
fill CREDENTIALS_KEY "$(random_hex 32)"
fill SHARED_API_TOKEN "$(random_hex 24)"
# Hex only: the API puts the password in a connection URL without escaping it.
fill POSTGRES_PASSWORD "$(random_hex 16)"
fill LIVEKIT_API_KEY "API$(random_hex 6)"
fill LIVEKIT_API_SECRET "$(random_hex 24)"

API_PORT=$(current API_PORT); API_PORT=${API_PORT:-4000}
UI_PORT=$(current UI_PORT); UI_PORT=${UI_PORT:-8080}

cat <<EOF

Ready. Start the stack with:

  docker compose up --build

Then:
  API          http://localhost:$API_PORT/api
  Health       http://localhost:$API_PORT/api/health
  Test page    http://localhost:$UI_PORT
  API key      $(current BOOTSTRAP_API_KEY)
               (BOOTSTRAP_API_KEY in .env; it works once the API has started)

To talk to an agent, add a model provider key to .env, for example
OPENAI_API_KEY, and restart with: docker compose up -d
EOF
