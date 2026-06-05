"""Optional SAML 2.0 authentication adapter."""

from __future__ import annotations

import logging
import os

from flask import Flask, Response


log = logging.getLogger(__name__)


def register_adapter(app: Flask) -> None:
    if not os.environ.get("PRG32_SAML_IDP_METADATA_URL"):
        return
    try:
        import onelogin  # noqa: F401
    except Exception as exc:  # pragma: no cover - optional dependency path
        log.warning("SAML auth disabled because python3-saml is not installed: %s", exc)
        return

    @app.get("/auth/saml/login")
    def auth_saml_login():
        return Response("SAML login is not configured for this deployment.\n", status=501)

    @app.post("/auth/saml/acs")
    def auth_saml_acs():
        return Response("SAML ACS is not configured for this deployment.\n", status=501)

    @app.get("/auth/saml/metadata")
    def auth_saml_metadata():
        return Response("SAML metadata is not configured for this deployment.\n", status=501)
