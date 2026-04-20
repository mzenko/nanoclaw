FROM python:3.12-slim

# Install caddy (bearer-token gate) + uv (workspace-mcp installer).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl debian-keyring debian-archive-keyring apt-transport-https gnupg \
    && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
    && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
        > /etc/apt/sources.list.d/caddy-stable.list \
    && apt-get update && apt-get install -y --no-install-recommends caddy bash \
    && rm -rf /var/lib/apt/lists/* \
    && curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
    && useradd -u 1000 -m node \
    && mkdir -p /home/node/.cache/uv /etc/caddy /etc/workspace-mcp /var/workspace-mcp/credentials \
    && chown -R node:node /home/node /var/workspace-mcp

COPY Caddyfile /etc/caddy/Caddyfile
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY client_secret.stub.json /etc/workspace-mcp/client_secret.json
RUN chmod +x /usr/local/bin/entrypoint.sh

USER node
WORKDIR /home/node

# Pre-install workspace-mcp so cold start is fast.
# Pinned: a major bump can change the --permissions flag or auth model.
ARG WORKSPACE_MCP_VERSION=1.19.0
# pysocks is required for httplib2 (used by google-api-python-client) to
# actually honor HTTPS_PROXY env vars — without it httplib2 silently bypasses
# the proxy. We need the proxy because the OneCLI gateway intercepts our
# Google API calls and injects real OAuth tokens.
#
# pysocks sends `Proxy-Authorization: basic ...` (lowercase) but OneCLI's
# token extractor does a case-sensitive `strip_prefix("Basic ")`. RFC 7617
# says the scheme is case-insensitive — so this is an OneCLI bug — but
# until that's patched upstream we capitalise the casing in pysocks at build
# time so the gateway recognises the agent token and switches from tunnel to
# MITM mode.
RUN uv tool install "workspace-mcp==${WORKSPACE_MCP_VERSION}" --with pysocks \
    && SOCKS_PY=/home/node/.local/share/uv/tools/workspace-mcp/lib/python3.12/site-packages/socks.py \
    && sed -i 's|Proxy-Authorization: basic |Proxy-Authorization: Basic |' "$SOCKS_PY" \
    && grep -q 'Proxy-Authorization: Basic ' "$SOCKS_PY" \
        || (echo "ERROR: pysocks Proxy-Authorization patch did not apply — check upstream casing" >&2 && exit 1)

# Stub OAuth client (real exchange happens at the OneCLI gateway) + an
# in-container creds dir so we don't need a host mount that could shadow
# our stub with stale real tokens during testing.
ENV PATH="/home/node/.local/bin:${PATH}" \
    GOOGLE_CLIENT_SECRET_PATH=/etc/workspace-mcp/client_secret.json \
    WORKSPACE_MCP_CREDENTIALS_DIR=/var/workspace-mcp/credentials

EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
