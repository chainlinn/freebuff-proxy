FROM node:20-alpine

# Install curl + jq
RUN apk add --no-cache curl jq

# Copy proxy server and install deps locally
COPY proxy.js /app/proxy.js
WORKDIR /app
RUN npm init -y && npm install https-proxy-agent@6
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Persistent credentials volume
VOLUME /app/data

ENV PROXY_PORT=8080
ENV BACKEND_URL="https://www.codebuff.com"

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]