FROM node:20-alpine

# Install curl + jq
RUN apk add --no-cache curl jq

# Install proxy agent library
RUN npm install -g https-proxy-agent && \
    ln -s /usr/local/lib/node_modules/https-proxy-agent /app/node_modules/https-proxy-agent

# Copy proxy server and entrypoint
COPY proxy.js /app/proxy.js
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Persistent credentials volume
VOLUME /app/data

ENV PROXY_PORT=8080
ENV BACKEND_URL="https://www.codebuff.com"

EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]