"""Optional LDAP / Active Directory authentication adapter."""

from __future__ import annotations

import logging
import os

from flask import Flask


log = logging.getLogger(__name__)


def register_adapter(app: Flask) -> None:
    if not os.environ.get("PRG32_LDAP_URL"):
        return
    try:
        import ldap3  # noqa: F401
    except Exception as exc:  # pragma: no cover - optional dependency path
        log.warning("LDAP auth disabled because ldap3 is not installed: %s", exc)
        return
    log.warning("LDAP auth is configured, but interactive LDAP login is not enabled in this build.")
