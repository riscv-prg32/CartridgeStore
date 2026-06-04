"""Shared users and role checks for PRG32 classroom services."""

from __future__ import annotations

from dataclasses import dataclass
import functools
import hmac
import json
import os
from typing import Any, Callable, Iterable

try:
    from flask import current_app, g, jsonify, request
except ImportError:  # pragma: no cover - lets the standalone relay import helpers
    current_app = None
    g = None
    jsonify = None
    request = None


ROLE_LEVELS = {
    "reader": 0,
    "player": 1,
    "publisher": 2,
    "admin": 3,
}


@dataclass(frozen=True)
class Principal:
    name: str
    role: str
    token: str = ""
    authenticated: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "role": self.role,
            "authenticated": self.authenticated,
        }


ANONYMOUS = Principal(name="anonymous", role="reader", authenticated=False)


def normalize_role(role: str) -> str:
    normalized = str(role or "").strip().lower()
    if normalized not in ROLE_LEVELS:
        raise ValueError(f"unknown role: {role!r}")
    return normalized


def role_at_least(actual: str, required: str) -> bool:
    return ROLE_LEVELS[normalize_role(actual)] >= ROLE_LEVELS[normalize_role(required)]


def _user_from_dict(data: dict[str, Any], token_hint: str = "") -> Principal:
    token = str(data.get("token") or token_hint).strip()
    if not token:
        raise ValueError("user token is required")
    role = normalize_role(str(data.get("role", "reader")))
    name = str(data.get("name") or data.get("user") or role).strip() or role
    return Principal(name=name, role=role, token=token, authenticated=True)


def _users_from_json(value: Any) -> list[Principal]:
    if isinstance(value, list):
        return [_user_from_dict(item) for item in value if isinstance(item, dict)]
    if isinstance(value, dict):
        users: list[Principal] = []
        for token, item in value.items():
            if isinstance(item, dict):
                users.append(_user_from_dict(item, token_hint=str(token)))
            else:
                users.append(
                    Principal(
                        name=str(item).strip() or "user",
                        role=normalize_role(str(item)),
                        token=str(token),
                        authenticated=True,
                    )
                )
        return users
    raise ValueError("user configuration must be a JSON array or object")


def parse_user_config(raw: Any) -> list[Principal]:
    """Parse a user configuration from app config or PRG32_USERS."""

    if raw in (None, "", []):
        return []
    if isinstance(raw, (list, dict)):
        return _users_from_json(raw)
    text = str(raw).strip()
    if not text:
        return []
    if text[0] in "[{":
        return _users_from_json(json.loads(text))

    users: list[Principal] = []
    for chunk in text.split(","):
        item = chunk.strip()
        if not item:
            continue
        parts = [part.strip() for part in item.split(":", 2)]
        if len(parts) != 3:
            raise ValueError("PRG32_USERS entries must be name:role:token")
        name, role, token = parts
        users.append(
            Principal(
                name=name or role,
                role=normalize_role(role),
                token=token,
                authenticated=True,
            )
        )
    return users


def users_from_environment() -> list[Principal]:
    return parse_user_config(os.environ.get("PRG32_USERS", ""))


def configured_users() -> list[Principal]:
    if current_app is None:
        return users_from_environment()
    raw = current_app.config.get("USERS")
    if raw is None:
        raw = os.environ.get("PRG32_USERS", "")
    return parse_user_config(raw)


def auth_is_configured() -> bool:
    return bool(configured_users())


def extract_token_from_headers(headers: Any, query_token: str = "") -> str:
    auth_header = str(headers.get("Authorization", "")).strip()
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    explicit = str(headers.get("X-PRG32-Token", "")).strip()
    return explicit or query_token.strip()


def request_token() -> str:
    if request is None:
        return ""
    token = extract_token_from_headers(request.headers, request.args.get("token", ""))
    if token:
        return token
    return str(request.form.get("token", "")).strip()


def authenticate_token(token: str, users: Iterable[Principal]) -> Principal:
    if not token:
        return ANONYMOUS
    for user in users:
        if hmac.compare_digest(token, user.token):
            return user
    return ANONYMOUS


def current_principal() -> Principal:
    if g is None:
        return authenticate_token("", configured_users())
    principal = getattr(g, "prg32_principal", None)
    if principal is None:
        principal = authenticate_token(request_token(), configured_users())
        g.prg32_principal = principal
    return principal


def require_role(role: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    required = normalize_role(role)

    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(func)
        def wrapper(*args: Any, **kwargs: Any):
            users = configured_users()
            if not users:
                return func(*args, **kwargs)

            principal = current_principal()
            if principal.authenticated and role_at_least(principal.role, required):
                return func(*args, **kwargs)

            status = 403 if principal.authenticated else 401
            if jsonify is None:
                raise RuntimeError("Flask is required for HTTP role checks")
            return (
                jsonify(
                    {
                        "ok": False,
                        "error": f"{required} role required",
                        "user": principal.as_dict(),
                    }
                ),
                status,
            )

        return wrapper

    return decorator
