#!/bin/sh
set -e

CREDENTIALS_FILE="/app/data/credentials.json"

# Step 1: Check for existing credentials or env var
get_api_key() {
    if [ -n "$CODEBUFF_API_KEY" ]; then
        echo "$CODEBUFF_API_KEY"
        return 0
    fi

    if [ -f "$CREDENTIALS_FILE" ]; then
        KEY=$(jq -r '.default.authToken' "$CREDENTIALS_FILE" 2>/dev/null)
        if [ -n "$KEY" ] && [ "$KEY" != "null" ]; then
            echo "$KEY"
            return 0
        fi
    fi

    return 1
}

# Step 2: Login via codebuff auth API
login() {
    echo "=== No API key found. Starting Freebuff login ==="
    echo ""

    FINGERPRINT=$(cat /proc/sys/kernel/random/uuid)
    CODE_RESPONSE=$(curl -s -X POST "${BACKEND_URL}/api/auth/cli/code" \
        -H "Content-Type: application/json" \
        -d "{\"fingerprintId\": \"${FINGERPRINT}\"}")

    LOGIN_URL=$(echo "$CODE_RESPONSE" | jq -r '.loginUrl // empty' 2>/dev/null)
    FINGERPRINT_HASH=$(echo "$CODE_RESPONSE" | jq -r '.fingerprintHash // empty' 2>/dev/null)
    EXPIRES_AT=$(echo "$CODE_RESPONSE" | jq -r '.expiresAt // empty' 2>/dev/null)

    if [ -z "$LOGIN_URL" ]; then
        echo "ERROR: Could not get login URL from server."
        echo "Response: $CODE_RESPONSE"
        echo ""
        echo "Set CODEBUFF_API_KEY env var manually:"
        echo "  1. npm install -g freebuff && freebuff"
        echo "  2. cat ~/.config/manicode/credentials.json | jq '.default.authToken'"
        echo "  3. Restart with CODEBUFF_API_KEY=<token>"
        exit 1
    fi

    echo "=============================================="
    echo "  Open this URL in your browser to login:"
    echo "  ${LOGIN_URL}"
    echo "=============================================="
    echo ""
    echo "Waiting for authentication..."

    MAX_WAIT=300
    ELAPSED=0
    while [ $ELAPSED -lt $MAX_WAIT ]; do
        STATUS=$(curl -s -G "${BACKEND_URL}/api/auth/cli/status" \
            --data-urlencode "fingerprintId=${FINGERPRINT}" \
            --data-urlencode "fingerprintHash=${FINGERPRINT_HASH}" \
            --data-urlencode "expiresAt=${EXPIRES_AT}")

        # Check for successful auth (HTTP 200 with user object)
        AUTH_TOKEN=$(echo "$STATUS" | jq -r '.user.authToken // empty' 2>/dev/null)

        if [ -n "$AUTH_TOKEN" ] && [ "$AUTH_TOKEN" != "null" ]; then
            echo "Login successful!"
            mkdir -p /app/data
            USER_NAME=$(echo "$STATUS" | jq -r '.user.name // "unknown"')
            USER_EMAIL=$(echo "$STATUS" | jq -r '.user.email // "unknown"')
            USER_ID=$(echo "$STATUS" | jq -r '.user.id // ""')
            cat > "$CREDENTIALS_FILE" <<EOF
{
  "default": {
    "authToken": "${AUTH_TOKEN}",
    "id": "${USER_ID}",
    "name": "${USER_NAME}",
    "email": "${USER_EMAIL}",
    "fingerprintId": "${FINGERPRINT}",
    "fingerprintHash": "${FINGERPRINT_HASH}"
  }
}
EOF
            echo "$AUTH_TOKEN"
            return 0
        fi

        sleep 5
        ELAPSED=$((ELAPSED + 5))
    done

    echo "ERROR: Login timed out after 5 minutes."
    exit 1
}

# Step 3: Get API key
if ! API_KEY=$(get_api_key); then
    API_KEY=$(login)
fi

echo ""
echo "=== Freebuff API Proxy ==="
echo "Backend:      ${BACKEND_URL}"
echo "Port:         ${PROXY_PORT}"
echo "Freebuff Key: ${API_KEY:0:8}..."
echo "=========================="

# Step 4: Substitute env vars into nginx config and start
envsubst '${API_KEY} ${BACKEND_URL}' \
    < /etc/nginx/nginx.conf \
    > /etc/nginx/nginx.conf.resolved

mv /etc/nginx/nginx.conf.resolved /etc/nginx/nginx.conf

echo "Starting nginx..."
exec nginx -g 'daemon off;'