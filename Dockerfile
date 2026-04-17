FROM node:20-alpine

# Install nginx + curl + jq
RUN apk add --no-cache nginx curl jq

# Install freebuff CLI globally
RUN npm install -g freebuff

# Copy configs
COPY nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Persistent credentials volume
VOLUME /app/data

ENV PROXY_PORT=8080
ENV BACKEND_URL="https://www.codebuff.com"

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]