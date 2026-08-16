#!/bin/sh
# Inject BRAVE_API_KEY into settings.yml before handing off. Absent key
# leaves the placeholder so misconfiguration surfaces in logs.
set -e
if [ -n "${BRAVE_API_KEY:-}" ]; then
  sed -i "s|__BRAVE_API_KEY__|${BRAVE_API_KEY}|" /etc/searxng/settings.yml
fi
exec /usr/local/searxng/entrypoint.sh "$@"
