"""Database-backed authentication and authorization helpers."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import functools
import hashlib
import hmac
import json
import os
import secrets
from typing import Any, Callable, Iterable

from flask import (
    Flask,
    Response,
    current_app,
    flash,
    g,
    has_app_context,
    jsonify,
    redirect,
    render_template,
    request,
    session,
    url_for,
)

from ..database import get_db


ROLE_LEVELS = {
    "reader": 0,
    "user": 1,
    "player": 1,
    "publisher": 2,
    "admin": 3,
}

AUTH_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    username          TEXT    NOT NULL UNIQUE,
    email             TEXT    NOT NULL UNIQUE,
    password_hash     TEXT,
    role              TEXT    NOT NULL DEFAULT 'user',
    external_id       TEXT,
    external_provider TEXT,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    last_login        TEXT
);

CREATE TABLE IF NOT EXISTS api_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT    NOT NULL UNIQUE,
    label       TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    last_used   TEXT
);

CREATE INDEX IF NOT EXISTS users_external_idx
ON users(external_provider, external_id);

CREATE INDEX IF NOT EXISTS api_tokens_user_idx
ON api_tokens(user_id);
"""


@dataclass(frozen=True)
class Principal:
    name: str
    role: str
    token: str = ""
    authenticated: bool = False
    id: int | None = None
    email: str = ""
    external_provider: str | None = None

    @property
    def username(self) -> str:
        return self.name

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "username": self.name,
            "email": self.email,
            "role": self.role,
            "authenticated": self.authenticated,
        }


ANONYMOUS = Principal(name="anonymous", role="reader", authenticated=False)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


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
    """Parse the legacy PRG32_USERS token configuration."""

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
    raw = current_app.config.get("USERS")
    if raw is None:
        raw = os.environ.get("PRG32_USERS", "")
    return parse_user_config(raw)


def auth_is_configured() -> bool:
    return True


def extract_token_from_headers(headers: Any, query_token: str = "") -> str:
    auth_header = str(headers.get("Authorization", "")).strip()
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    explicit = str(headers.get("X-PRG32-Token", "")).strip()
    return explicit or query_token.strip()


def request_token() -> str:
    token = extract_token_from_headers(request.headers, request.args.get("token", ""))
    if token:
        return token
    return str(request.form.get("token", "")).strip()


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def init_auth_db() -> None:
    db = get_db()
    db.executescript(AUTH_SCHEMA)
    db.commit()


def principal_from_row(row: Any | None, *, token: str = "") -> Principal:
    if row is None:
        return ANONYMOUS
    return Principal(
        id=int(row["id"]),
        name=str(row["username"]),
        email=str(row["email"] or ""),
        role=normalize_role(str(row["role"] or "user")),
        token=token,
        authenticated=True,
        external_provider=row["external_provider"],
    )


def load_user(user_id: int) -> Principal:
    row = get_db().execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return principal_from_row(row)


def user_count() -> int:
    row = get_db().execute("SELECT COUNT(*) AS count FROM users").fetchone()
    return int(row["count"] if row else 0)


def authenticate_token(token: str, users: Iterable[Principal] | None = None) -> Principal:
    if not token:
        return ANONYMOUS

    if has_app_context():
        row = get_db().execute(
            """
            SELECT users.*, api_tokens.id AS token_id
            FROM api_tokens
            JOIN users ON users.id = api_tokens.user_id
            WHERE api_tokens.token_hash = ?
            """,
            (token_hash(token),),
        ).fetchone()
        if row:
            get_db().execute(
                "UPDATE api_tokens SET last_used = ? WHERE id = ?",
                (utc_now(), row["token_id"]),
            )
            get_db().commit()
            return principal_from_row(row, token=token)

    for user in users if users is not None else configured_users():
        if hmac.compare_digest(token, user.token):
            return user
    return ANONYMOUS


def current_principal() -> Principal:
    principal = getattr(g, "prg32_principal", None)
    if principal is not None:
        return principal

    user_id = session.get("user_id")
    if user_id is not None:
        try:
            principal = load_user(int(user_id))
        except (TypeError, ValueError):
            principal = ANONYMOUS
        if principal.authenticated:
            g.prg32_principal = principal
            return principal

    principal = authenticate_token(request_token())
    g.prg32_principal = principal
    return principal


def _wants_json() -> bool:
    if request.path.startswith("/api/") or request.path.startswith("/auth/"):
        return True
    best = request.accept_mimetypes.best_match(["application/json", "text/html"])
    return best == "application/json" and request.accept_mimetypes[best] > 0


def _auth_failure(message: str, status: int) -> Response | tuple[Response, int]:
    if _wants_json():
        return jsonify({"ok": False, "error": message, "user": current_principal().as_dict()}), status
    if status == 401:
        return redirect(url_for("auth_login", next=request.full_path))
    return render_template("error.html", error=message), status


def login_required(func: Callable[..., Any]) -> Callable[..., Any]:
    @functools.wraps(func)
    def wrapper(*args: Any, **kwargs: Any):
        if current_principal().authenticated:
            return func(*args, **kwargs)
        return _auth_failure("login required", 401)

    return wrapper


def admin_required(func: Callable[..., Any]) -> Callable[..., Any]:
    @functools.wraps(func)
    def wrapper(*args: Any, **kwargs: Any):
        principal = current_principal()
        if not principal.authenticated:
            return _auth_failure("login required", 401)
        if not role_at_least(principal.role, "admin"):
            return _auth_failure("admin role required", 403)
        return func(*args, **kwargs)

    return wrapper


def require_role(role: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    required = normalize_role(role)

    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(func)
        def wrapper(*args: Any, **kwargs: Any):
            principal = current_principal()
            if principal.authenticated and role_at_least(principal.role, required):
                return func(*args, **kwargs)
            status = 403 if principal.authenticated else 401
            return _auth_failure(f"{required} role required", status)

        return wrapper

    return decorator


def _next_url(default: str = "index") -> str:
    target = request.args.get("next") or request.form.get("next") or ""
    if target.startswith("/") and not target.startswith("//"):
        return target
    return url_for(default)


def _token_response(token_id: int, label: str, token: str) -> dict[str, Any]:
    return {"ok": True, "id": token_id, "label": label, "token": token}


def register_auth_routes(app: Flask) -> None:
    from .local import authenticate_local_user, create_local_user, validate_registration
    from .ldap_adapter import register_adapter as register_ldap_adapter
    from .oidc_adapter import register_adapter as register_oidc_adapter
    from .saml_adapter import register_adapter as register_saml_adapter

    @app.before_request
    def before_auth_request() -> None:
        init_auth_db()

    @app.context_processor
    def inject_current_user() -> dict[str, Any]:
        return {"current_user": current_principal()}

    @app.get("/auth/register")
    def auth_register_form():
        return render_template("auth_register.html")

    @app.post("/auth/register")
    def auth_register():
        errors = validate_registration(request.form)
        allow_registration = True
        try:
            from ..settings import get_setting

            allow_registration = get_setting("auth_allow_registration", "true") == "true"
            domain = get_setting("auth_require_email_domain", "")
        except Exception:
            domain = ""

        if user_count() == 0:
            allow_registration = True
        if not allow_registration:
            errors.append("registration is closed")
        if domain:
            email = request.form.get("email", "").strip().lower()
            if not email.endswith("@" + domain.lower().lstrip("@")):
                errors.append(f"email must belong to {domain}")
        if errors:
            if _wants_json():
                return jsonify({"ok": False, "error": "; ".join(errors)}), 400
            return render_template("auth_register.html", errors=errors), 400

        role = "admin" if user_count() == 0 else "user"
        if role != "admin":
            try:
                from ..settings import get_setting

                role = get_setting("auth_default_role", "user")
            except Exception:
                role = "user"
            if role not in ("user", "admin"):
                role = "user"
        user_id = create_local_user(
            request.form["username"],
            request.form["email"],
            request.form["password"],
            role=role,
        )
        session.clear()
        session["user_id"] = user_id
        session["role"] = role
        if _wants_json():
            return jsonify({"ok": True, "user": load_user(user_id).as_dict()})
        flash("Account created.")
        return redirect(_next_url())

    @app.get("/auth/login")
    def auth_login_form():
        return render_template("auth_login.html", next=request.args.get("next", ""))

    @app.post("/auth/login")
    def auth_login():
        username = request.form.get("username", "")
        password = request.form.get("password", "")
        principal = authenticate_local_user(username, password)
        if not principal.authenticated:
            if _wants_json():
                return jsonify({"ok": False, "error": "invalid username or password"}), 401
            return render_template("auth_login.html", error="Invalid username or password."), 401
        get_db().execute(
            "UPDATE users SET last_login = ? WHERE id = ?",
            (utc_now(), principal.id),
        )
        get_db().commit()
        session.clear()
        session["user_id"] = principal.id
        session["role"] = principal.role
        if _wants_json():
            return jsonify({"ok": True, "user": principal.as_dict()})
        return redirect(_next_url())

    @app.post("/auth/logout")
    @login_required
    def auth_logout():
        session.clear()
        if _wants_json():
            return jsonify({"ok": True})
        return redirect(url_for("index"))

    @app.get("/auth/me")
    @login_required
    def auth_me():
        return jsonify({"ok": True, "user": current_principal().as_dict()})

    @app.post("/auth/tokens")
    @login_required
    def auth_create_token():
        principal = current_principal()
        label = request.form.get("label", "")
        if request.is_json:
            data = request.get_json(silent=True) or {}
            label = data.get("label", label)
        label = str(label or "API token").strip()[:80]
        token = "prg32_" + secrets.token_urlsafe(32)
        cursor = get_db().execute(
            "INSERT INTO api_tokens(user_id, token_hash, label) VALUES (?, ?, ?)",
            (principal.id, token_hash(token), label),
        )
        get_db().commit()
        return jsonify(_token_response(int(cursor.lastrowid), label, token))

    @app.delete("/auth/tokens/<int:token_id>")
    @login_required
    def auth_delete_token(token_id: int):
        cursor = get_db().execute(
            "DELETE FROM api_tokens WHERE id = ? AND user_id = ?",
            (token_id, current_principal().id),
        )
        get_db().commit()
        return jsonify({"ok": cursor.rowcount > 0})

    register_ldap_adapter(app)
    register_saml_adapter(app)
    register_oidc_adapter(app)
