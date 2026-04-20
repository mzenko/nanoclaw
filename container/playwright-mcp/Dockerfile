FROM mcr.microsoft.com/playwright/mcp:latest

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl debian-keyring debian-archive-keyring apt-transport-https gnupg bash \
    && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
    && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
        > /etc/apt/sources.list.d/caddy-stable.list \
    && apt-get update && apt-get install -y --no-install-recommends caddy \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /etc/caddy

COPY Caddyfile /etc/caddy/Caddyfile
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER node
EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
