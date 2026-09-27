# Nginx, TLS e proxy de confiança

Nginx deve ser o único ponto público. O contentor Crontab UI permanece numa rede interna e não deve publicar a porta 8000 no anfitrião em produção. O Compose base não inclui Nginx; o contentor/serviço Nginx gerido pelo deployment tem de integrar a rede `crontab-ui_default` ou uma rede externa partilhada declarada no Compose.

Configure `TRUSTED_PROXY` com o endereço ou CIDR da rede de onde o Nginx realmente liga ao contentor. Não use um valor amplo apenas para aceitar cabeçalhos enviados pelo cliente. A aplicação usa este valor para decidir se confia na origem directa; só então `X-Forwarded-For` influencia o IP registado e `X-Forwarded-Proto` permite reconhecer HTTPS.

Exemplo de virtual host TLS:

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
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

O valor de `TRUSTED_PROXY` deve corresponder à topologia efectiva. `172.20.0.0/16` é apenas ilustrativo; confirme a rede com `docker network inspect crontab-ui_default` antes do deployment. Se o Nginx for um contentor externo ao projecto Compose, ligue-o explicitamente à rede antes de usar o nome de serviço em `proxy_pass`:

```bash
docker network connect crontab-ui_default <contentor-nginx>
```

TLS no proxy não substitui autenticação, RBAC ou CSRF: mantenha `BASIC_AUTH_USERS_JSON`, `AUTHZ_ROLE_MAP_JSON` e `CSRF_SECRET` configurados no contentor da aplicação.
