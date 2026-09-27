# Nginx, TLS, and trusted proxy

Nginx should be the only public entry point. The Crontab UI container remains on an internal network and must not expose port 8000 on the host in production. The base Compose file does not include Nginx, but it declares the shared `crontab-ui-internal` network; the proxy Compose project must reference it as an external network so the connection survives Nginx container recreation.

Configure `TRUSTED_PROXY` with the address or network CIDR from which Nginx actually connects to the container. Do not use a broad value merely to accept client-provided headers. The application uses this value to decide whether to trust the direct source; only then does `X-Forwarded-For` affect the recorded IP and does `X-Forwarded-Proto` allow HTTPS recognition.

Example TLS virtual host:

```nginx
server {
    listen 80;
    server_name crontab.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name crontab.example.com;

    ssl_certificate     /etc/letsencrypt/live/crontab.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/crontab.example.com/privkey.pem;

    location / {
        proxy_pass http://crontab-ui:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

The `TRUSTED_PROXY` value must match the effective topology. `172.20.0.0/16` is illustrative only; confirm the network with `docker network inspect crontab-ui-internal` before deployment. If Nginx is managed by another Compose project, declare the network as external in that project instead of using manual `docker network connect`:

```yaml
services:
  nginx:
    # Image, certificates, and ports are managed by the deployment.
    networks:
      - crontab-ui-internal

networks:
  crontab-ui-internal:
    external: true
    name: ${CRONTAB_UI_NETWORK:-crontab-ui-internal}
```

If there is more than one legitimate proxy, configure the full chain and review client IP handling. In the single public-proxy scenario, `X-Forwarded-For $remote_addr` prevents forwarding a value supplied by the client.

TLS at the proxy does not replace authentication, RBAC, or CSRF protection: keep `BASIC_AUTH_USERS_JSON`, `AUTHZ_ROLE_MAP_JSON`, and `CSRF_SECRET` configured in the application container.
