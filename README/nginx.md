# Nginx, TLS e proxy de confiança

Nginx deve ser o único ponto público. O contentor Crontab UI permanece numa rede interna e não deve publicar a porta 8000 no anfitrião em produção. O Compose base não inclui Nginx, mas declara a rede partilhada `crontab-ui-internal`; o Compose do proxy deve referenciá-la como rede externa para que a ligação sobreviva à recriação do contentor Nginx.

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
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

O valor de `TRUSTED_PROXY` deve corresponder à topologia efectiva. `172.20.0.0/16` é apenas ilustrativo; confirme a rede com `docker network inspect crontab-ui-internal` antes do deployment. Se o Nginx for gerido por outro projecto Compose, declare a rede como externa nesse projecto em vez de usar `docker network connect` manualmente:

```yaml
services:
  nginx:
    # imagem, certificados e portas são geridos pelo deployment
    networks:
      - crontab-ui-internal

networks:
  crontab-ui-internal:
    external: true
    name: ${CRONTAB_UI_NETWORK:-crontab-ui-internal}
```

Se houver mais do que um proxy legítimo, configure a cadeia completa e reveja o tratamento de IP de cliente. No cenário de um único proxy público, `X-Forwarded-For $remote_addr` impede o transporte de um valor enviado pelo cliente.

TLS no proxy não substitui autenticação, RBAC ou CSRF: mantenha `BASIC_AUTH_USERS_JSON`, `AUTHZ_ROLE_MAP_JSON` e `CSRF_SECRET` configurados no contentor da aplicação.
