FROM ghcr.io/homeassistant-ai/ha-mcp:latest

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

# Override upstream's fastmcp-http.json with a loopback-bound variant; Caddy
# is the only thing that gets to listen on the public port.
COPY fastmcp-http.json /app/fastmcp-http.json
COPY Caddyfile /etc/caddy/Caddyfile
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && chown mcpuser:mcpuser /app/fastmcp-http.json

USER mcpuser
EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
