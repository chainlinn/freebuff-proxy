FROM nginx:alpine

# Install jq for JSON processing in auth script
RUN apk add --no-cache jq curl

# Copy nginx config and entrypoint script
COPY nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Environment variables
ENV CODEBUFF_API_KEY=""
ENV BACKEND_URL="https://www.codebuff.com"
ENV PROXY_PORT=8080

ENTRYPOINT ["/entrypoint.sh"]