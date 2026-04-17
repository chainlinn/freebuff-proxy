#!/bin/sh
set -e

if [ -z "$CODEBUFF_API_KEY" ]; then
    echo "ERROR: CODEBUFF_API_KEY is not set."
    echo ""
    echo "To get your API key:"
    echo "  1. Install freebuff:  npm install -g freebuff"
    echo "  2. Run 'freebuff' and complete login"
    echo "  3. Find your key at:  ~/.config/manicode/credentials.json"
    echo "     (look for 'authToken' field)"
    echo ""
    echo "Then set CODEBUFF_API_KEY env var when starting the container."
    exit 1
fi

echo "=== Freebuff API Proxy ==="
echo "Backend: ${BACKEND_URL}"
echo "Port:    ${PROXY_PORT}"
echo "=========================="

# Substitute env vars into nginx config
envsubst '${CODEBUFF_API_KEY} ${BACKEND_URL}' \
    < /etc/nginx/nginx.conf \
    > /etc/nginx/nginx.conf.resolved

mv /etc/nginx/nginx.conf.resolved /etc/nginx/nginx.conf

echo "Starting nginx..."
exec nginx -g 'daemon off;'
