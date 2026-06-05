"""Store settings and theme context helpers."""

from __future__ import annotations

import time
from typing import Any

from flask import Flask

from .database import get_db


SETTINGS_SCHEMA = """
CREATE TABLE IF NOT EXISTS store_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

DEFAULT_SETTINGS = {
    "store_name": "PRG32 Cartridge Store",
    "store_tagline": "",
    "store_contact_email": "",
    "store_institution": "",
    "theme_primary_color": "#1a73e8",
    "theme_secondary_color": "#174ea6",
    "theme_font_family": "system-ui, sans-serif",
    "theme_logo_url": "",
    "theme_favicon_url": "",
    "theme_custom_css": "",
    "auth_allow_registration": "true",
    "auth_require_email_domain": "",
    "auth_default_role": "user",
    "publish_require_auth": "true",
    "publish_max_bundle_mb": "64",
    "publish_allowed_architectures": "qemu,esp32c6",
    "mdns_enabled": "true",
    "mdns_name": "",
    "mdns_type": "_prg32store._tcp.local.",
    "mdns_port": "5080",
    "smtp_host": "",
    "smtp_port": "587",
    "smtp_from": "noreply@localhost",
    "smtp_user": "",
    "smtp_password": "",
    "smtp_tls": "true",
    "oidc_enabled": "false",
    "oidc_issuer": "",
    "oidc_client_id": "",
    "oidc_client_secret": "",
    "oidc_scope": "openid email profile",
    "saml_enabled": "false",
    "saml_entity_id": "",
    "saml_acs_url": "",
    "saml_sls_url": "",
    "saml_idp_entity_id": "",
    "saml_idp_sso_url": "",
    "saml_idp_slo_url": "",
    "saml_idp_x509cert": "",
}

_theme_cache: tuple[float, dict[str, str]] | None = None


def init_settings_db() -> None:
    db = get_db()
    db.executescript(SETTINGS_SCHEMA)
    db.commit()


def get_setting(key: str, default: Any = None) -> str:
    fallback = DEFAULT_SETTINGS.get(key, default)
    row = get_db().execute("SELECT value FROM store_settings WHERE key = ?", (key,)).fetchone()
    if row is None:
        return "" if fallback is None else str(fallback)
    return str(row["value"])


def set_setting(key: str, value: Any) -> None:
    global _theme_cache
    get_db().execute(
        """
        INSERT INTO store_settings(key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        """,
        (key, str(value)),
    )
    get_db().commit()
    _theme_cache = None


def theme_context() -> dict[str, str]:
    global _theme_cache
    now = time.monotonic()
    if _theme_cache is not None and now - _theme_cache[0] < 60:
        return dict(_theme_cache[1])
    values = {key: get_setting(key, default) for key, default in DEFAULT_SETTINGS.items()}
    values["color_primary"] = values["theme_primary_color"]
    values["color_secondary"] = values["theme_secondary_color"]
    _theme_cache = (now, values)
    return dict(values)


def register_settings(app: Flask) -> None:
    @app.before_request
    def before_settings_request() -> None:
        init_settings_db()

    @app.context_processor
    def inject_theme() -> dict[str, str]:
        return theme_context()
