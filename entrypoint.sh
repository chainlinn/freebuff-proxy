#!/bin/sh

echo "========================================="
echo "  freebuff-proxy v2024.04.17-3"
echo "  Starting at: $(date '+%Y-%m-%d %H:%M:%S')"
echo "========================================="

CREDENTIALS_FILE="/app/data/credentials.json"

# Step 1: Get API key
echo "[DEBUG] Checking CODEBUFF_API_KEY env var..."
if [ -n "$CODEBUFF_API_KEY" ]; then
    API_KEY="$CODEBUFF_API_KEY"
    echo "[INFO] Using CODEBUFF_API_KEY from env (${API_KEY:0:8}...)"
else
    echo "[DEBUG] No env var, checking saved credentials..."
    if [ -f "$CREDENTIALS_FILE" ]; then
        API_KEY=$(jq -r '.default.authToken' "$CREDENTIALS_FILE" 2>/dev/null)
        if [ -n "$API_KEY" ] && [ "$API_KEY" != "null" ] && [ "$API_KEY" != "" ]; then
            echo "[INFO] Using saved credentials (${API_KEY:0:8}...)"
        else
            API_KEY=""
        fi
    else
        API_KEY=""
    fi
fi

# Step 2: Login if no key
if [ -z "$API_KEY" ]; then
    echo "[INFO] No API key found. Starting login flow..."

    FINGERPRINT=$(cat /proc/sys/kernel/random/uuid)
    echo "[DEBUG] Fingerprint: $FINGERPRINT"

    CODE_RESPONSE=$(curl -s -X POST "${BACKEND_URL}/api/auth/cli/code" \
        -H "Content-Type: application/json" \
        -d "{\"fingerprintId\": \"${FINGERPRINT}\"}")

    echo "[DEBUG] Code response: $CODE_RESPONSE"

    LOGIN_URL=$(echo "$CODE_RESPONSE" | jq -r '.loginUrl // empty' 2>/dev/null)
    FINGERPRINT_HASH=$(echo "$CODE_RESPONSE" | jq -r '.fingerprintHash // empty' 2>/dev/null)
    EXPIRES_AT=$(echo "$CODE_RESPONSE" | jq -r '.expiresAt // empty' 2>/dev/null)

    if [ -z "$LOGIN_URL" ]; then
        echo "ERROR: Could not get login URL."
        echo "Response: $CODE_RESPONSE"
        exec tail -f /dev/null
    fi

    echo ""
    echo "========================================="
    echo "  >>> Open this URL in your browser <<<"
    echo "  ${LOGIN_URL}"
    echo "========================================="
    echo ""

    MAX_WAIT=300
    ELAPSED=0
    while [ $ELAPSED -lt $MAX_WAIT ]; do
        STATUS=$(curl -s -G "${BACKEND_URL}/api/auth/cli/status" \
            --data-urlencode "fingerprintId=${FINGERPRINT}" \
            --data-urlencode "fingerprintHash=${FINGERPRINT_HASH}" \
            --data-urlencode "expiresAt=${EXPIRES_AT}")

        AUTH_TOKEN=$(echo "$STATUS" | jq -r '.user.authToken // empty' 2>/dev/null)

        if [ -n "$AUTH_TOKEN" ] && [ "$AUTH_TOKEN" != "null" ]; then
            echo "[INFO] Login successful!"
            mkdir -p /app/data
            USER_NAME=$(echo "$STATUS" | jq -r '.user.name // "unknown"')
            USER_EMAIL=$(echo "$STATUS" | jq -r '.user.email // "unknown"')
            USER_ID=$(echo "$STATUS" | jq -r '.user.id // ""')
            cat > "$CREDENTIALS_FILE" <<EOF
{"default":{"authToken":"${AUTH_TOKEN}","id":"${USER_ID}","name":"${USER_NAME}","email":"${USER_EMAIL}","fingerprintId":"${FINGERPRINT}","fingerprintHash":"${FINGERPRINT_HASH}"}}
EOF
            API_KEY="$AUTH_TOKEN"
            break
        fi

        sleep 5
        ELAPSED=$((ELAPSED + 5))
    done

    if [ -z "$API_KEY" ]; then
        echo "[ERROR] Login timed out."
        exec tail -f /dev/null
    fi
fi

echo ""
echo "=== Freebuff API Proxy ==="
echo "  Version: v2024.04.17-3"
echo "  Time:    $(date '+%Y-%m-%d %H:%M:%S')"
echo "  Backend: ${BACKEND_URL}"
echo "  Port:    ${PROXY_PORT}"
echo "  Key:     ${API_KEY:0:8}..."
echo "=========================="

# Step 3: Write API key to file for proxy server to read
echo -n "$API_KEY" > /tmp/api_key

# Step 4: Start the Node.js proxy server
echo "[INFO] Starting proxy server..."
exec node /app/proxy.js
