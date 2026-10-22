"""Store settings and theme context helpers."""

from __future__ import annotations

import time
from typing import Any

from flask import Flask, current_app

from .database import get_db, init_schema_once


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
    "privacy_controller_name": "",
    "privacy_controller_address": "",
    "privacy_contact_email": "",
    "privacy_dpo_email": "",
    "privacy_supervisory_authority": "",
    "privacy_supervisory_authority_url": "",
    "privacy_download_retention_days": "90",
    "privacy_metrics_retention_days": "365",
    "privacy_registration_retention_days": "7",
    "privacy_audit_retention_days": "365",
    "privacy_representative": "",
    "privacy_recipient_categories": "",
    "privacy_transfer_details": "No international transfers are configured by the Cartridge Store itself.",
    "privacy_data_provision": "Account email and authentication data are required to provide an account; without them an account cannot be created.",
    "privacy_processing_records": "[]",
}

# Keyed by database path so separate apps (and tests) never share themes.
_theme_cache: dict[str, tuple[float, dict[str, str]]] = {}


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
    get_db().execute(
        """
        INSERT INTO store_settings(key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        """,
        (key, str(value)),
    )
    get_db().commit()
    _theme_cache.pop(str(current_app.config["DATABASE"]), None)


def theme_context() -> dict[str, str]:
    key = str(current_app.config["DATABASE"])
    now = time.monotonic()
    cached = _theme_cache.get(key)
    if cached is not None and now - cached[0] < 60:
        return dict(cached[1])
    values = {key: get_setting(key, default) for key, default in DEFAULT_SETTINGS.items()}
    values["color_primary"] = values["theme_primary_color"]
    values["color_secondary"] = values["theme_secondary_color"]
    _theme_cache[key] = (now, values)
    return dict(values)


def register_settings(app: Flask) -> None:
    @app.before_request
    def before_settings_request() -> None:
        init_schema_once("settings", init_settings_db)

    @app.context_processor
    def inject_theme() -> dict[str, str]:
        return theme_context()
