# Deployment

PRG32 Cartrige Store should run behind HTTPS in production, with persistent
storage mounted outside the container or process directory.

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `SECRET_KEY` | required | Flask session signing key |
| `PRG32_STORE_DATA` | `data` or `/data` in Docker | Cartridge files, custom static assets, and default DB location |
| `PRG32_STORE_DB` | `<data>/cartrige_store.sqlite` | Unified SQLite database |
| `PRG32_SCORE_DB` | unset | Legacy score DB fallback |
| `PRG32_METRICS_DB` | unset | Legacy metrics DB fallback |
| `PRG32_BUNDLE_MAX_MB` | `64` | Zip bundle upload limit |
| `PRG32_MP_MAX_PEERS` | `8` | WebSocket peers per multiplayer room |
| `PRG32_USERS` | unset | Legacy `name:role:token` compatibility tokens |
| `PRG32_SMTP_HOST` | unset | SMTP host for registration emails |
| `PRG32_SMTP_PORT` | `587` | SMTP port |
| `PRG32_SMTP_FROM` | `noreply@localhost` | Registration email sender |
| `PRG32_SMTP_USER` | unset | SMTP username |
| `PRG32_SMTP_PASSWORD` | unset | SMTP password |
| `PRG32_SMTP_TLS` | `true` | Enable STARTTLS for SMTP |
| `PRG32_MDNS_DISABLED` | unset | Set to `1` to disable mDNS advertisement |
| `PRG32_MDNS_NAME` | `PRG32 Cartrige Store` | mDNS instance name |
| `PRG32_MDNS_TYPE` | `_http._tcp.local.` | mDNS service type |
| `PRG32_MDNS_PORT` | `5080` | mDNS advertised HTTP port |
| `PRG32_LDAP_URL` | unset | LDAP activation URL |
| `PRG32_LDAP_BASE_DN` | unset | LDAP search base |
| `PRG32_LDAP_BIND_DN` | unset | LDAP service account DN |
| `PRG32_LDAP_BIND_PW` | unset | LDAP service account password |
| `PRG32_LDAP_USER_ATTR` | `uid` | LDAP username attribute |
| `PRG32_LDAP_ADMIN_GROUP` | unset | LDAP admin group DN |
| `PRG32_OIDC_ENABLED` | unset | Set to `true` to enable OIDC |
| `PRG32_OIDC_ISSUER` | unset | OIDC issuer discovery URL |
| `PRG32_OIDC_CLIENT_ID` | unset | OIDC client id |
| `PRG32_OIDC_CLIENT_SECRET` | unset | OIDC client secret |
| `PRG32_OIDC_SCOPE` | `openid email profile` | OIDC scopes |
| `PRG32_SAML_ENABLED` | unset | Set to `true` to enable SAML2 |
| `PRG32_SAML_ENTITY_ID` | unset | SAML service-provider entity id |
| `PRG32_SAML_ACS_URL` | unset | SAML assertion consumer URL |
| `PRG32_SAML_SLS_URL` | unset | SAML single logout URL |
| `PRG32_SAML_IDP_ENTITY_ID` | unset | SAML identity-provider entity id |
| `PRG32_SAML_IDP_SSO_URL` | unset | SAML identity-provider SSO URL |
| `PRG32_SAML_IDP_SLO_URL` | unset | SAML identity-provider logout URL |
| `PRG32_SAML_IDP_X509CERT` | unset | SAML identity-provider signing certificate |

## Production Checklist

- Set a high-entropy `SECRET_KEY`.
- Change the seeded `admin` / `password` administrator credentials.
- Configure SMTP so user registration links are delivered by email.
- Configure mDNS, SMTP, OIDC, and SAML2 from `/setup` or environment variables.
- Disable Flask debug mode; use Gunicorn or the Docker image.
- Put the service behind HTTPS termination.
- Preserve `PRG32_STORE_DATA` on durable storage.
- Use `/admin/backup` for full backups, or back up `cartrige_store.sqlite`,
  `index.json`, `cartridges/`, custom static assets, and pending submissions
  under `pending/`.
- Configure reverse-proxy request size limits above `PRG32_BUNDLE_MAX_MB`.
- Proxy WebSocket upgrades for `/api/multiplayer`.
- Keep `zeroconf` installed if you want mDNS advertisement in production.

Example Nginx WebSocket location:

```nginx
location /api/multiplayer {
    proxy_pass http://127.0.0.1:5080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

## Docker

Compose requires `SECRET_KEY`:

```bash
export SECRET_KEY="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
docker compose up --build
```

The image continues if `zeroconf` is absent, but mDNS advertisement is disabled
with a startup warning.
