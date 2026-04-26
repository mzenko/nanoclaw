FROM mcr.microsoft.com/playwright/mcp@sha256:7b82f29c6ef83480a97f612d53ac3fd5f30a32df3fea1e06923d4204d3532bb2

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl debian-keyring debian-archive-keyring apt-transport-https gnupg bash \
    && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
    && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
        > /etc/apt/sources.list.d/caddy-stable.list \
    && apt-get update && apt-get install -y --no-install-recommends caddy \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /etc/caddy /tmp/playwright-mcp \
    && chown -R node:node /tmp/playwright-mcp

COPY Caddyfile /etc/caddy/Caddyfile
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER node
WORKDIR /home/node
EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
