#!/bin/sh
set -e

CREDENTIALS_FILE="/app/data/credentials.json"

# Step 1: Check for existing credentials or env var
get_api_key() {
    # Priority 1: env var
    if [ -n "$CODEBUFF_API_KEY" ]; then
        echo "$CODEBUFF_API_KEY"
        return 0
    fi

    # Priority 2: saved credentials
    if [ -f "$CREDENTIALS_FILE" ]; then
        KEY=$(jq -r '.default.authToken' "$CREDENTIALS_FILE" 2>/dev/null)
        if [ -n "$KEY" ] && [ "$KEY" != "null" ]; then
            echo "$KEY"
            return 0
        fi
    fi

    return 1
}

# Step 2: Login via freebuff CLI if no key
login() {
    echo "=== No API key found. Starting Freebuff login ==="
    echo ""

    # Use freebuff's built-in login flow
    # This creates a device code and prints a login URL
    freebuff auth login --output json > /tmp/login_response.json 2>&1 || true

    # If that doesn't work, try the manual approach
    if [ ! -s /tmp/login_response.json ]; then
        echo "Attempting manual login flow..."
        # Request a login code from codebuff API
        FINGERPRINT=$(cat /proc/sys/kernel/random/uuid)
        RESPONSE=$(curl -s -X POST "${BACKEND_URL}/api/auth/cli/code" \
            -H "Content-Type: application/json" \
            -d "{\"fingerprintId\": \"${FINGERPRINT}\"}")

        LOGIN_URL=$(echo "$RESPONSE" | jq -r '.url // .loginUrl // empty' 2>/dev/null)
        CODE=$(echo "$RESPONSE" | jq -r '.code // .deviceCode // empty' 2>/dev/null)

        if [ -z "$LOGIN_URL" ]; then
            echo "ERROR: Could not get login URL from server."
            echo "Response: $RESPONSE"
            echo ""
            echo "Alternative: Set CODEBUFF_API_KEY env var manually:"
            echo "  1. Install freebuff on your host: npm install -g freebuff"
            echo "  2. Run 'freebuff' and login"
            echo "  3. cat ~/.config/manicode/credentials.json | jq '.default.authToken'"
            echo "  4. docker compose run freebuff-proxy with CODEBUFF_API_KEY=<token>"
            exit 1
        fi

        echo "=============================================="
        echo "  Open this URL in your browser to login:"
        echo "  ${LOGIN_URL}"
        echo "=============================================="
        echo ""
        echo "Waiting for authentication..."

        # Poll for auth status
        MAX_WAIT=300  # 5 minutes
        ELAPSED=0
        while [ $ELAPSED -lt $MAX_WAIT ]; do
            STATUS=$(curl -s -X GET "${BACKEND_URL}/api/auth/cli/status" \
                -H "Content-Type: application/json" \
                -G \
                --data-urlencode "fingerprintId=${FINGERPRINT}")

            AUTH_TOKEN=$(echo "$STATUS" | jq -r '.authToken // .token // empty' 2>/dev/null)

            if [ -n "$AUTH_TOKEN" ] && [ "$AUTH_TOKEN" != "null" ] && [ "$AUTH_TOKEN" != "" ]; then
                echo "Login successful!"
                # Save credentials
                mkdir -p /app/data
                echo "$STATUS" | jq '{default: {authToken: (.authToken // .token), id: .id, email: .email, name: .name, fingerprintId: "'${FINGERPRINT}'"}}' > "$CREDENTIALS_FILE"
                echo "$AUTH_TOKEN"
                return 0
            fi

            sleep 3
            ELAPSED=$((ELAPSED + 3))
        done

        echo "ERROR: Login timed out after 5 minutes."
        exit 1
    fi
}

# Step 3: Get API key
if ! API_KEY=$(get_api_key); then
    API_KEY=$(login)
fi

echo ""
echo "=== Freebuff API Proxy ==="
echo "Backend:  ${BACKEND_URL}"
echo "Port:     ${PROXY_PORT}"
echo "Key:      ${API_KEY:0:8}..."
echo "=========================="

# Step 4: Substitute env vars into nginx config and start
envsubst '${API_KEY} ${BACKEND_URL}' \
    < /etc/nginx/nginx.conf \
    > /etc/nginx/nginx.conf.resolved

mv /etc/nginx/nginx.conf.resolved /etc/nginx/nginx.conf

echo "Starting nginx..."
exec nginx -g 'daemon off;'