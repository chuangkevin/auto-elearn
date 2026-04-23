---
name: deployment
description: Use whenever a HomeProject service is being deployed, updated on Raspberry Pi or another host, packaged into Docker, wired into Caddy or Cloudflare Tunnel, or prepared for CI/CD release. Covers Docker build, GitHub Actions setup, compose/deploy workflow, routing changes, remote-host upstreams, and post-deploy verification.
---

# Deployment to HomeProject Hosts

## Standard Flow

```
Code change → git push target branch
  → docker-publish.yml builds image (single-arch or multi-arch as needed) → Docker Hub
  → deploy workflow: Tailscale OAuth / SSH → docker compose pull + up on target host
  → service exposed either directly on target host or via RPi Caddy / Cloudflare Tunnel
```

## 1. Docker Image

If the service is deployed only on RPi, ARM64 (`aarch64`) is sufficient.
If the service spans RPi and amd64 hosts, use multi-arch builds.

Examples:

```yaml
# RPi-only service
runs-on: ubuntu-24.04-arm
```

```yaml
# Mixed amd64 + arm64 service
runs-on: ubuntu-latest
platforms: linux/amd64,linux/arm64
```

Image naming should match the environment strategy, for example:
- `kevin950805/<project-name>:latest` for production
- `kevin950805/<project-name>:dev` for test/dev

If project uses `@kevinsisi/ai-core`:
- Lockfile must use `git+https://` URLs
- Dockerfile must install `git` using the repo's standard package manager path (prefer Debian-based images and `apt-get`)

## 2. GitHub Actions

Copy from `kevinsisi/home-media` or `kevinsisi/project-bridge`.

Required secrets:
- `TS_OAUTH_CLIENT_ID` / `TS_OAUTH_SECRET` — org-level Tailscale OAuth
- `DOCKERHUB_TOKEN` — repo-level, extracted from docker-credential-desktop

Exception: `key-manager` uses a self-hosted runner instead of Tailscale OAuth.
Runner registered at `/home/kevin/actions-runner/` on RPi.

## 3. Docker Compose on Target Host

Create `<deploy-path>/docker-compose.yml` on the target host:

```yaml
services:
  <project-name>:
    image: kevin950805/<project-name>:<tag>
    container_name: <project-name>
    restart: unless-stopped
    ports:
      - "<host-port>:3000"
    volumes:
      - ./<project-name>_data:/app/data
```

Choose an unused port. See URL Routing Table in CLAUDE.md for taken ports.

For long-term persistent data, prefer bind mounts to known host paths over ad-hoc named volumes when the service has a dedicated data disk.

## 4. Routing

If the service is still routed through the RPi reverse proxy, edit `/home/kevin/DockerCompose/caddy/Caddyfile`.

Inside `*.sisihome.org {}` block:
```
@<name> host <name>.sisihome.org
handle @<name> {
    reverse_proxy <upstream-host>:<port>
}
```

Below the wildcard block:
```
http://<name>.sisihome {
    reverse_proxy <upstream-host>:<port>
}
```

**Important**: the active Caddyfile and the bind-mount source must match. Validate the real mount source before editing.
After editing: `cd /home/kevin/DockerCompose/caddy && docker compose restart`

If the service uses SSE: `reverse_proxy <upstream-host>:<port> { flush_interval -1 }`

## 4.1 Public exposure hardening gate

Before exposing a service publicly beyond the current private/Tailscale model, require all of the following:

- `super_admin` login restricted to Tailscale / LAN source ranges
- SSH restricted to Tailscale / LAN only
- correct real-client-IP handling behind reverse proxy / tunnel
- backup coverage for DB, `.env`, and `service-account.json`

If the long-term plan is to remove the RPi dependency, prefer Cloudflare Tunnel on the target host instead of adding more reverse-proxy coupling.

## 5. Update CLAUDE.md

Add row to URL Routing Table:
```
| `https://<name>.sisihome.org` | `http://<name>.sisihome` | Description | <port> |
```

## 6. Verify Deployment

```bash
ssh <user>@<target-host>
docker ps | grep <project-name>
curl -s http://localhost:<port>/health || curl -s http://localhost:<port>/
```

Then open the final route (`https://<name>.sisihome.org` or the tunnel hostname) in browser.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Image not found | Check the expected environment tag exists in Docker Hub (`latest`, `dev`, etc.) |
| Container starts then dies | `docker logs <name>` for errors |
| Caddy returns 502 | Container not running, or wrong port |
| Caddy returns 404 | Hostname not in Caddyfile |
| HTTPS cert error | Caddy needs restart to pick up new wildcard; check `CF_API_TOKEN` |
| SSH connection refused | Check Tailscale is connected and the target host accepts the deploy key |
| Reverse proxy works on target host but public domain still fails | Check DNS records, wildcard conflicts, and whether the proxy/tunnel is pointing to the right upstream |
