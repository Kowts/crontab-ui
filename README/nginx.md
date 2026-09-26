Hosting
=======

Use Nginx as the only public endpoint. The application must stay on an internal Docker network or loopback interface; do not expose port 8000 publicly.

```
sudo vi /etc/nginx/sites-available/default
```
Change it to this
```
server {
    listen 80;
    server_name crontab.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name crontab.example.com;
    ssl_certificate /etc/letsencrypt/live/crontab.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/crontab.example.com/privkey.pem;

    location / {
        proxy_pass http://crontab-ui:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

Authentication
==============

Set `TRUSTED_PROXY` to the Nginx container or network CIDR. In production the application refuses plain HTTP unless it receives HTTPS through that configured proxy.

```
BASIC_AUTH_USER=user BASIC_AUTH_PWD=SecretPassword
```

You can also enable basic http authentication with user name and password on nginx to prevent unauthorized users from accessing your cronjobs. Refer [this](https://www.digitalocean.com/community/tutorials/how-to-set-up-http-authentication-with-nginx-on-ubuntu-12-10).

