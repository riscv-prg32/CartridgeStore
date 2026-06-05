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
| `PRG32_LDAP_URL` | unset | LDAP activation URL |
| `PRG32_LDAP_BASE_DN` | unset | LDAP search base |
| `PRG32_LDAP_BIND_DN` | unset | LDAP service account DN |
| `PRG32_LDAP_BIND_PW` | unset | LDAP service account password |
| `PRG32_LDAP_USER_ATTR` | `uid` | LDAP username attribute |
| `PRG32_LDAP_ADMIN_GROUP` | unset | LDAP admin group DN |
| `PRG32_SAML_IDP_METADATA_URL` | unset | SAML activation metadata URL/path |
| `PRG32_SAML_SP_ENTITY_ID` | `prg32-cartrige-store` | SAML SP entity id |
| `PRG32_SAML_SP_ACS_URL` | unset | SAML ACS URL |
| `PRG32_SAML_ADMIN_ENTITLEMENT` | unset | Entitlement value mapped to admin |
| `PRG32_OIDC_ISSUER` | unset | OIDC issuer discovery URL |
| `PRG32_OIDC_CLIENT_ID` | unset | OIDC client id |
| `PRG32_OIDC_CLIENT_SECRET` | unset | OIDC client secret |
| `PRG32_OIDC_SCOPES` | `openid email profile` | OIDC scopes |
| `PRG32_OIDC_ADMIN_CLAIM` | unset | ID-token JSON path mapped to admin |

## Production Checklist

- Set a high-entropy `SECRET_KEY`.
- Disable Flask debug mode; use Gunicorn or the Docker image.
- Put the service behind HTTPS termination.
- Preserve `PRG32_STORE_DATA` on durable storage.
- Back up `cartrige_store.sqlite`, `index.json`, and `cartridges/`.
- Configure reverse-proxy request size limits above `PRG32_BUNDLE_MAX_MB`.
- Proxy WebSocket upgrades for `/api/multiplayer`.

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
