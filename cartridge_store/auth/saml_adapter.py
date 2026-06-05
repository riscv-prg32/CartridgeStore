"""Optional SAML 2.0 authentication adapter."""

from __future__ import annotations

import logging
import os
from typing import Any

from flask import Flask, Response, redirect, request, session, url_for

from . import load_user, upsert_external_user, utc_now
from ..database import get_db


log = logging.getLogger(__name__)


def register_adapter(app: Flask) -> None:
    config = _saml_config(app)
    if config["enabled"].lower() not in {"1", "true", "yes"}:
        return
    if not config["idp_sso_url"] or not config["idp_entity_id"] or not config["idp_x509cert"]:
        log.warning("SAML auth disabled because IdP SSO URL, entity id, or certificate is missing")
        return
    try:
        from onelogin.saml2.auth import OneLogin_Saml2_Auth
        from onelogin.saml2.settings import OneLogin_Saml2_Settings
    except Exception as exc:  # pragma: no cover - optional dependency path
        log.warning("SAML auth disabled because python3-saml is not installed: %s", exc)
        return

    @app.get("/auth/saml/login")
    def auth_saml_login():
        auth = OneLogin_Saml2_Auth(_prepare_flask_request(), _saml_settings(config))
        return redirect(auth.login())

    @app.post("/auth/saml/acs")
    def auth_saml_acs():
        auth = OneLogin_Saml2_Auth(_prepare_flask_request(), _saml_settings(config))
        auth.process_response()
        errors = auth.get_errors()
        if errors or not auth.is_authenticated():
            log.warning("SAML ACS failed: %s %s", errors, auth.get_last_error_reason())
            return Response("SAML authentication failed.\n", status=401)
        attrs = auth.get_attributes()
        email = _first_attr(attrs, "email", "mail", "Email")
        external_id = auth.get_nameid() or email
        user_id = upsert_external_user(
            provider="saml",
            external_id=external_id,
            email=email,
            username=email,
            role="user",
        )
        get_db().execute("UPDATE users SET last_login = ? WHERE id = ?", (utc_now(), user_id))
        get_db().commit()
        principal = load_user(user_id)
        session.clear()
        session["user_id"] = principal.id
        session["role"] = principal.role
        return redirect(url_for("index"))

    @app.get("/auth/saml/metadata")
    def auth_saml_metadata():
        settings = OneLogin_Saml2_Settings(_saml_settings(config), sp_validation_only=True)
        metadata = settings.get_sp_metadata()
        errors = settings.validate_metadata(metadata)
        if errors:
            return Response("\n".join(errors), status=500, mimetype="text/plain")
        return Response(metadata, mimetype="application/xml")


def _saml_config(app: Flask) -> dict[str, str]:
    values = {
        "enabled": os.environ.get("PRG32_SAML_ENABLED", ""),
        "entity_id": os.environ.get("PRG32_SAML_ENTITY_ID", ""),
        "acs_url": os.environ.get("PRG32_SAML_ACS_URL", ""),
        "sls_url": os.environ.get("PRG32_SAML_SLS_URL", ""),
        "idp_entity_id": os.environ.get("PRG32_SAML_IDP_ENTITY_ID", ""),
        "idp_sso_url": os.environ.get("PRG32_SAML_IDP_SSO_URL", ""),
        "idp_slo_url": os.environ.get("PRG32_SAML_IDP_SLO_URL", ""),
        "idp_x509cert": os.environ.get("PRG32_SAML_IDP_X509CERT", ""),
    }
    try:
        from ..settings import get_setting, init_settings_db

        with app.app_context():
            init_settings_db()
            for key in values:
                values[key] = values[key] or get_setting("saml_" + key, "")
    except Exception:
        pass
    base = app.config.get("PREFERRED_URL_SCHEME", "http") + "://localhost"
    values["entity_id"] = values["entity_id"] or base + "/auth/saml/metadata"
    values["acs_url"] = values["acs_url"] or base + "/auth/saml/acs"
    return values


def _saml_settings(config: dict[str, str]) -> dict[str, Any]:
    return {
        "strict": True,
        "debug": False,
        "sp": {
            "entityId": config["entity_id"],
            "assertionConsumerService": {
                "url": config["acs_url"],
                "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
            },
            "singleLogoutService": {
                "url": config["sls_url"],
                "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
            },
            "NameIDFormat": "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
        },
        "idp": {
            "entityId": config["idp_entity_id"],
            "singleSignOnService": {
                "url": config["idp_sso_url"],
                "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
            },
            "singleLogoutService": {
                "url": config["idp_slo_url"],
                "binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
            },
            "x509cert": config["idp_x509cert"],
        },
    }


def _prepare_flask_request() -> dict[str, Any]:
    return {
        "https": "on" if request.scheme == "https" else "off",
        "http_host": request.host,
        "server_port": request.environ.get("SERVER_PORT"),
        "script_name": request.path,
        "get_data": request.args.copy(),
        "post_data": request.form.copy(),
    }


def _first_attr(attrs: dict[str, list[str]], *names: str) -> str:
    for name in names:
        values = attrs.get(name)
        if values:
            return str(values[0])
    raise ValueError("SAML response must include an email attribute")
