#!/bin/sh
# Probe ESL — if FreeSWITCH is listening, it's healthy enough.
nc -z 127.0.0.1 8021 || exit 1
exit 0
