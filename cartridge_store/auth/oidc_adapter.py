"""Optional OpenID Connect authentication adapter."""

from __future__ import annotations

import logging
import os
from typing import Any

from flask import Flask, redirect, request, session, url_for

from . import load_user, upsert_external_user, utc_now
from ..database import get_db


log = logging.getLogger(__name__)


def register_adapter(app: Flask) -> None:
    config = _oidc_config(app)
    if config["enabled"].lower() not in {"1", "true", "yes"}:
        return
    if not config["issuer"] or not config["client_id"] or not config["client_secret"]:
        log.warning("OIDC auth disabled because issuer, client id, or client secret is missing")
        return
    try:
        from authlib.integrations.flask_client import OAuth
    except Exception as exc:  # pragma: no cover - optional dependency path
        log.warning("OIDC auth disabled because authlib is not installed: %s", exc)
        return

    oauth = OAuth(app)
    oidc = oauth.register(
        name="prg32_oidc",
        server_metadata_url=config["issuer"].rstrip("/") + "/.well-known/openid-configuration",
        client_id=config["client_id"],
        client_secret=config["client_secret"],
        client_kwargs={"scope": config["scope"]},
    )

    @app.get("/auth/oidc/login")
    def auth_oidc_login():
        redirect_uri = url_for("auth_oidc_callback", _external=True)
        return oidc.authorize_redirect(redirect_uri)

    @app.get("/auth/oidc/callback")
    def auth_oidc_callback():
        token = oidc.authorize_access_token()
        profile = _oidc_profile(oidc, token)
        user_id = upsert_external_user(
            provider="oidc",
            external_id=str(profile["sub"]),
            email=str(profile["email"]),
            username=str(profile.get("preferred_username") or profile["email"]),
            role="user",
        )
        get_db().execute("UPDATE users SET last_login = ? WHERE id = ?", (utc_now(), user_id))
        get_db().commit()
        principal = load_user(user_id)
        session.clear()
        session["user_id"] = principal.id
        session["role"] = principal.role
        return redirect(url_for("index"))


def _oidc_config(app: Flask) -> dict[str, str]:
    values = {
        "enabled": os.environ.get("PRG32_OIDC_ENABLED", ""),
        "issuer": os.environ.get("PRG32_OIDC_ISSUER", ""),
        "client_id": os.environ.get("PRG32_OIDC_CLIENT_ID", ""),
        "client_secret": os.environ.get("PRG32_OIDC_CLIENT_SECRET", ""),
        "scope": os.environ.get("PRG32_OIDC_SCOPE", "openid email profile"),
    }
    try:
        from ..settings import get_setting, init_settings_db

        with app.app_context():
            init_settings_db()
            values["enabled"] = values["enabled"] or get_setting("oidc_enabled", "false")
            values["issuer"] = values["issuer"] or get_setting("oidc_issuer", "")
            values["client_id"] = values["client_id"] or get_setting("oidc_client_id", "")
            values["client_secret"] = values["client_secret"] or get_setting("oidc_client_secret", "")
            values["scope"] = values["scope"] or get_setting("oidc_scope", "openid email profile")
    except Exception:
        pass
    return values


def _oidc_profile(oidc: Any, token: dict[str, Any]) -> dict[str, Any]:
    profile = token.get("userinfo") or {}
    if not profile:
        parsed = oidc.parse_id_token(token)
        profile = dict(parsed)
    if not profile.get("sub") or not profile.get("email"):
        response = oidc.get("userinfo", token=token)
        profile = response.json()
    if not profile.get("sub") or not profile.get("email"):
        raise ValueError("OIDC profile must include sub and email")
    return dict(profile)
