"""Optional OpenID Connect authentication adapter."""

from __future__ import annotations

import logging
import os

from flask import Flask, Response


log = logging.getLogger(__name__)


def register_adapter(app: Flask) -> None:
    if not os.environ.get("PRG32_OIDC_ISSUER"):
        return
    try:
        import authlib  # noqa: F401
    except Exception as exc:  # pragma: no cover - optional dependency path
        log.warning("OIDC auth disabled because authlib is not installed: %s", exc)
        return

    @app.get("/auth/oidc/login")
    def auth_oidc_login():
        return Response("OIDC login is not configured for this deployment.\n", status=501)

    @app.get("/auth/oidc/callback")
    def auth_oidc_callback():
        return Response("OIDC callback is not configured for this deployment.\n", status=501)
