"""Database-backed authentication and authorization helpers."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
import functools
import hashlib
import hmac
import json
import os
import secrets
import smtplib
import re
import time
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
from werkzeug.security import generate_password_hash

from ..database import add_column_if_missing, get_db, init_schema_once


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
    updated_at        TEXT,
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

CREATE TABLE IF NOT EXISTS groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_groups (
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    PRIMARY KEY(user_id, group_id)
);

CREATE TABLE IF NOT EXISTS registration_tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    used_at    TEXT
);

CREATE INDEX IF NOT EXISTS registration_tokens_email_idx
ON registration_tokens(email, used_at, expires_at);
"""

PUBLIC_HANDLE_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{2,31}$")


@dataclass(frozen=True)
class Principal:
    name: str
    role: str
    token: str = ""
    authenticated: bool = False
    id: int | None = None
    email: str = ""
    external_provider: str | None = None
    groups: tuple[str, ...] = ()

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
            "groups": list(self.groups),
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
    # Changed whenever an account changes; user sync with a Construction Kit keeps the newest.
    add_column_if_missing(db, "users", "updated_at", "TEXT")
    add_column_if_missing(db, "users", "public_handle", "TEXT")
    _migrate_public_handles(db)
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS users_public_handle_idx ON users(public_handle)")
    db.execute("INSERT OR IGNORE INTO groups(name) VALUES ('editors')")
    db.commit()
    ensure_default_admin()


def ensure_default_admin() -> None:
    """Seed the bootstrap administrator only when the store has no admin.

    Renaming or deleting the seeded account must not bring back a user with
    the well-known default password, so nothing happens once any admin exists.
    """
    db = get_db()
    if db.execute("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").fetchone():
        return
    taken = db.execute(
        "SELECT 1 FROM users WHERE username = 'admin' OR email = 'admin@localhost'"
    ).fetchone()
    if taken:
        return
    password = os.environ.get("PRG32_ADMIN_PASSWORD") or "password"
    cursor = db.execute(
        """
        INSERT INTO users(username, email, password_hash, role, public_handle)
        VALUES (?, ?, ?, 'admin', ?)
        """,
        ("admin", "admin@localhost", generate_password_hash(password), unique_public_handle("admin")),
    )
    db.commit()
    add_user_to_group(int(cursor.lastrowid), "editors")


def principal_from_row(row: Any | None, *, token: str = "") -> Principal:
    if row is None:
        return ANONYMOUS
    return Principal(
        id=int(row["id"]),
        name=str(row["public_handle"] or f"player-{int(row['id']):06d}"),
        email=str(row["email"] or ""),
        role=normalize_role(str(row["role"] or "user")),
        token=token,
        authenticated=True,
        external_provider=row["external_provider"],
        groups=groups_for_user(int(row["id"])),
    )


def load_user(user_id: int) -> Principal:
    row = get_db().execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return principal_from_row(row)


def user_count() -> int:
    row = get_db().execute("SELECT COUNT(*) AS count FROM users").fetchone()
    return int(row["count"] if row else 0)


def group_id(name: str) -> int:
    normalized = str(name).strip().lower()
    if not normalized:
        raise ValueError("group name is required")
    db = get_db()
    db.execute("INSERT OR IGNORE INTO groups(name) VALUES (?)", (normalized,))
    row = db.execute("SELECT id FROM groups WHERE name = ?", (normalized,)).fetchone()
    db.commit()
    return int(row["id"])


def add_user_to_group(user_id: int, group: str) -> None:
    get_db().execute(
        "INSERT OR IGNORE INTO user_groups(user_id, group_id) VALUES (?, ?)",
        (user_id, group_id(group)),
    )
    get_db().commit()


def remove_user_from_group(user_id: int, group: str) -> None:
    get_db().execute(
        """
        DELETE FROM user_groups
        WHERE user_id = ? AND group_id = (SELECT id FROM groups WHERE name = ?)
        """,
        (user_id, group),
    )
    get_db().commit()


def set_user_group(user_id: int, group: str, enabled: bool) -> None:
    if enabled:
        add_user_to_group(user_id, group)
    else:
        remove_user_from_group(user_id, group)


def groups_for_user(user_id: int) -> tuple[str, ...]:
    rows = get_db().execute(
        """
        SELECT groups.name
        FROM user_groups
        JOIN groups ON groups.id = user_groups.group_id
        WHERE user_groups.user_id = ?
        ORDER BY groups.name
        """,
        (user_id,),
    ).fetchall()
    return tuple(str(row["name"]) for row in rows)


def set_user_groups(user_id: int, groups: Iterable[str]) -> None:
    normalized = sorted({str(group).strip().lower() for group in groups if str(group).strip()})
    db = get_db()
    db.execute("DELETE FROM user_groups WHERE user_id = ?", (user_id,))
    for group in normalized:
        db.execute(
            "INSERT OR IGNORE INTO user_groups(user_id, group_id) VALUES (?, ?)",
            (user_id, group_id(group)),
        )
    db.commit()


def principal_in_group(principal: Principal, group: str) -> bool:
    return str(group).strip().lower() in principal.groups


def upsert_external_user(
    *,
    provider: str,
    external_id: str,
    email: str,
    username: str = "",
    role: str = "user",
) -> int:
    provider = str(provider).strip().lower()
    external_id = str(external_id).strip()
    email = _normalize_email(email)
    username = str(username or email or external_id).strip()
    if not provider or not external_id or not email:
        raise ValueError("provider, external_id, and email are required")
    role = normalize_role(role)
    db = get_db()
    row = db.execute(
        """
        SELECT id
        FROM users
        WHERE external_provider = ? AND external_id = ?
        """,
        (provider, external_id),
    ).fetchone()
    if row is None:
        # Link by the IdP-asserted email only. Matching on username would let
        # an IdP user named e.g. "admin" take over the local admin account.
        row = db.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
    if row is None:
        cursor = db.execute(
            """
            INSERT INTO users(username, email, role, external_provider, external_id, public_handle)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (_unique_username(username, email), email, role, provider, external_id, unique_public_handle()),
        )
        db.commit()
        _sync_user(int(cursor.lastrowid))
        return int(cursor.lastrowid)
    previous = db.execute("SELECT email FROM users WHERE id = ?", (int(row["id"]),)).fetchone()
    db.execute(
        """
        UPDATE users
        SET email = ?, external_provider = ?, external_id = ?,
            public_handle = COALESCE(public_handle, ?)
        WHERE id = ?
        """,
        (email, provider, external_id, unique_public_handle(), int(row["id"])),
    )
    db.commit()
    _sync_user(int(row["id"]), previous_email=str(previous["email"]) if previous else None)
    return int(row["id"])


def _sync_user(user_id: int, previous_email: str | None = None) -> None:
    """Tell a synced Construction Kit (if any) that this user changed."""
    from ..sso import user_changed

    user_changed(user_id, previous_email=previous_email)


def _unique_username(preferred: str, email: str) -> str:
    db = get_db()
    for candidate in (preferred, email):
        if not db.execute("SELECT 1 FROM users WHERE username = ?", (candidate,)).fetchone():
            return candidate
    suffix = 2
    while db.execute("SELECT 1 FROM users WHERE username = ?", (f"{email}-{suffix}",)).fetchone():
        suffix += 1
    return f"{email}-{suffix}"


def normalize_public_handle(value: str) -> str:
    handle = str(value or "").strip().lower()
    if "@" in handle or not PUBLIC_HANDLE_RE.fullmatch(handle):
        raise ValueError("public handle must be 3-32 lowercase letters, numbers, underscores, or hyphens")
    return handle


def unique_public_handle(preferred: str = "") -> str:
    db = get_db()
    if preferred:
        candidate = normalize_public_handle(preferred)
        if db.execute("SELECT 1 FROM users WHERE public_handle = ?", (candidate,)).fetchone() is None:
            return candidate
        raise ValueError("public handle is already in use")
    while True:
        candidate = "player-" + secrets.token_hex(4)
        if db.execute("SELECT 1 FROM users WHERE public_handle = ?", (candidate,)).fetchone() is None:
            return candidate


def _migrate_public_handles(db: Any) -> None:
    rows = db.execute("SELECT id, username, public_handle FROM users ORDER BY id").fetchall()
    used = {str(row["public_handle"]) for row in rows if row["public_handle"]}
    for row in rows:
        if row["public_handle"]:
            continue
        username = str(row["username"] or "").strip().lower()
        candidate = username if "@" not in username and PUBLIC_HANDLE_RE.fullmatch(username) else f"player-{int(row['id']):06d}"
        base = candidate[:28]
        suffix = 2
        while candidate in used:
            candidate = f"{base}-{suffix}"
            suffix += 1
        db.execute("UPDATE users SET public_handle = ? WHERE id = ?", (candidate, int(row["id"])))
        used.add(candidate)


def authenticate_token(token: str, users: Iterable[Principal] | None = None) -> Principal:
    if not token:
        return ANONYMOUS

    if has_app_context() and token.startswith("sso1."):
        # A one-time ticket from the synced Construction Kit, publishing as one of our users.
        from ..sso import use_ticket

        email = use_ticket(token, "api")
        if email is None:
            return ANONYMOUS
        row = get_db().execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        return principal_from_row(row)

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


def csrf_token() -> str:
    token = session.get("csrf_token")
    if not token:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token
    return str(token)


def recently_authenticated(max_age_seconds: int = 900) -> bool:
    if request_token():
        return True
    try:
        return time.time() - float(session.get("authenticated_at", 0)) <= max_age_seconds
    except (TypeError, ValueError):
        return False


def _wants_json() -> bool:
    if request.path.startswith("/api/") or request.is_json:
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


def group_required(group: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    required = str(group).strip().lower()

    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        @functools.wraps(func)
        def wrapper(*args: Any, **kwargs: Any):
            principal = current_principal()
            if not principal.authenticated:
                return _auth_failure("login required", 401)
            if principal_in_group(principal, required):
                return func(*args, **kwargs)
            return _auth_failure(f"{required} group required", 403)

        return wrapper

    return decorator


editor_required = group_required("editors")


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


def _token_record(row: Any) -> dict[str, Any]:
    return {
        "id": int(row["id"]),
        "label": str(row["label"] or "API token"),
        "created_at": str(row["created_at"]),
        "last_used": str(row["last_used"] or ""),
    }


def _tokens_for_user(user_id: int) -> list[dict[str, Any]]:
    rows = get_db().execute(
        """
        SELECT id, label, created_at, last_used
        FROM api_tokens
        WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
        """,
        (user_id,),
    ).fetchall()
    return [_token_record(row) for row in rows]


def _normalize_email(email: str) -> str:
    return str(email or "").strip().lower()


def _registration_expires_at() -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")


def _create_registration_token(email: str) -> str:
    token = secrets.token_urlsafe(32)
    db = get_db()
    db.execute(
        """
        UPDATE registration_tokens
        SET used_at = datetime('now')
        WHERE email = ? AND used_at IS NULL
        """,
        (email,),
    )
    db.execute(
        """
        INSERT INTO registration_tokens(email, token_hash, expires_at)
        VALUES (?, ?, ?)
        """,
        (email, token_hash(token), _registration_expires_at()),
    )
    db.commit()
    return token


def _load_registration_token(token: str) -> dict[str, Any] | None:
    if not token:
        return None
    row = get_db().execute(
        """
        SELECT *
        FROM registration_tokens
        WHERE token_hash = ?
          AND used_at IS NULL
          AND expires_at > datetime('now')
        """,
        (token_hash(token),),
    ).fetchone()
    return dict(row) if row else None


def _mark_registration_token_used(token_id: int) -> None:
    get_db().execute(
        "UPDATE registration_tokens SET used_at = datetime('now') WHERE id = ?",
        (token_id,),
    )
    get_db().commit()


def _send_registration_email(email: str, link: str) -> None:
    if current_app.config.get("TESTING"):
        current_app.extensions["prg32_last_registration"] = {
            "email": email,
            "link": link,
            "token": link.rsplit("token=", 1)[-1],
        }
        return
    try:
        from ..settings import get_setting

        host = os.environ.get("PRG32_SMTP_HOST", get_setting("smtp_host", "")).strip()
        port = int(os.environ.get("PRG32_SMTP_PORT", get_setting("smtp_port", "587")))
        sender = os.environ.get("PRG32_SMTP_FROM", get_setting("smtp_from", "noreply@localhost"))
        username = os.environ.get("PRG32_SMTP_USER", get_setting("smtp_user", ""))
        password = os.environ.get("PRG32_SMTP_PASSWORD", get_setting("smtp_password", ""))
        tls_default = get_setting("smtp_tls", "true")
    except Exception:
        host = os.environ.get("PRG32_SMTP_HOST", "").strip()
        port = int(os.environ.get("PRG32_SMTP_PORT", "587"))
        sender = os.environ.get("PRG32_SMTP_FROM", "noreply@localhost")
        username = os.environ.get("PRG32_SMTP_USER", "")
        password = os.environ.get("PRG32_SMTP_PASSWORD", "")
        tls_default = "true"
    if not host:
        current_app.logger.warning("Registration link for %s: %s", email, link)
        return
    use_tls = os.environ.get("PRG32_SMTP_TLS", tls_default).lower() not in {"0", "false", "no"}

    message = EmailMessage()
    message["From"] = sender
    message["To"] = email
    message["Subject"] = "Complete your PRG32 Cartridge Store registration"
    message.set_content(
        "Open this link to finish your PRG32 Cartridge Store registration:\n\n"
        f"{link}\n\n"
        "The link expires in 24 hours.\n"
    )
    with smtplib.SMTP(host, port, timeout=10) as smtp:
        if use_tls:
            smtp.starttls()
        if username:
            smtp.login(username, password)
        smtp.send_message(message)


def register_auth_routes(app: Flask) -> None:
    from .local import (
        authenticate_local_user,
        create_local_user,
        validate_email_registration,
        validate_registration_password,
    )
    from .ldap_adapter import register_adapter as register_ldap_adapter
    from .oidc_adapter import register_adapter as register_oidc_adapter
    from .saml_adapter import register_adapter as register_saml_adapter

    @app.before_request
    def before_auth_request() -> None:
        init_schema_once("auth", init_auth_db)

    @app.context_processor
    def inject_current_user() -> dict[str, Any]:
        return {"current_user": current_principal(), "csrf_token": csrf_token}

    @app.before_request
    def protect_browser_forms_from_csrf():
        if not current_app.config.get("CSRF_ENABLED", True):
            return None
        if request.method not in {"POST", "PUT", "PATCH", "DELETE"}:
            return None
        if request.is_json or request_token() or request.path in {"/auth/saml/acs", "/auth/sso/accept"}:
            return None
        supplied = request.form.get("csrf_token", "") or request.headers.get("X-CSRF-Token", "")
        expected = session.get("csrf_token", "")
        if expected and supplied and hmac.compare_digest(str(expected), str(supplied)):
            return None
        return _auth_failure("invalid or missing CSRF token", 400)

    @app.get("/auth/register")
    def auth_register_form():
        return render_template("auth_register.html")

    @app.post("/auth/register")
    def auth_register():
        errors = validate_email_registration(request.form)
        allow_registration = True
        email = _normalize_email(request.form.get("email", ""))
        try:
            from ..settings import get_setting

            allow_registration = get_setting("auth_allow_registration", "true") == "true"
            domain = get_setting("auth_require_email_domain", "")
        except Exception:
            domain = ""

        if not allow_registration:
            errors.append("registration is closed")
        if domain:
            if not email.endswith("@" + domain.lower().lstrip("@")):
                errors.append(f"email must belong to {domain}")
        if errors:
            if _wants_json():
                return jsonify({"ok": False, "error": "; ".join(errors)}), 400
            return render_template("auth_register.html", errors=errors), 400

        existing = get_db().execute(
            "SELECT id FROM users WHERE email = ? OR username = ?",
            (email, email),
        ).fetchone()
        if existing is None:
            token = _create_registration_token(email)
            link = url_for("auth_register_complete_form", token=token, _external=True)
            _send_registration_email(email, link)
        if _wants_json():
            from ..privacy import PRIVACY_NOTICE_VERSION

            return jsonify({
                "ok": True,
                "email": email,
                "message": "registration email sent",
                "privacy_notice": {
                    "version": PRIVACY_NOTICE_VERSION,
                    "url": url_for("privacy_notice", _external=True),
                },
            })
        return render_template("auth_register_sent.html", email=email)

    @app.get("/auth/register/complete")
    def auth_register_complete_form():
        token = request.args.get("token", "")
        record = _load_registration_token(token)
        if record is None:
            return render_template("error.html", error="Registration link is invalid or expired."), 400
        return render_template("auth_register_complete.html", email=record["email"], token=token)

    @app.post("/auth/register/complete")
    def auth_register_complete():
        token = request.form.get("token", "")
        record = _load_registration_token(token)
        if record is None:
            if _wants_json():
                return jsonify({"ok": False, "error": "registration link is invalid or expired"}), 400
            return render_template("error.html", error="Registration link is invalid or expired."), 400

        errors = validate_registration_password(request.form)
        if current_app.config.get("CSRF_ENABLED", True):
            from ..privacy import PRIVACY_NOTICE_VERSION

            if request.form.get("privacy_notice_version", "") != PRIVACY_NOTICE_VERSION:
                errors.append("you must acknowledge the current privacy notice")
        public_handle = request.form.get("public_handle", "")
        if public_handle:
            try:
                normalize_public_handle(public_handle)
                if get_db().execute("SELECT 1 FROM users WHERE public_handle = ?", (public_handle.strip().lower(),)).fetchone():
                    errors.append("public handle is already in use")
            except ValueError as exc:
                errors.append(str(exc))
        if errors:
            if _wants_json():
                return jsonify({"ok": False, "error": "; ".join(errors)}), 400
            return render_template(
                "auth_register_complete.html",
                email=record["email"],
                token=token,
                errors=errors,
            ), 400

        email = _normalize_email(record["email"])
        existing = get_db().execute(
            "SELECT id FROM users WHERE email = ? OR username = ?",
            (email, email),
        ).fetchone()
        if existing is not None:
            _mark_registration_token_used(int(record["id"]))
            if _wants_json():
                return jsonify({"ok": False, "error": "account already exists"}), 400
            return render_template("error.html", error="Account already exists."), 400

        try:
            from ..settings import get_setting

            role = get_setting("auth_default_role", "user")
        except Exception:
            role = "user"
        if role not in ("user", "admin"):
            role = "user"
        user_id = create_local_user(
            email,
            email,
            request.form["password"],
            role=role,
            public_handle=public_handle,
        )
        from ..privacy import mark_privacy_notice_delivered

        mark_privacy_notice_delivered(user_id, "api" if _wants_json() else "local-registration")
        if role == "admin":
            add_user_to_group(user_id, "editors")
        _mark_registration_token_used(int(record["id"]))
        _sync_user(user_id)
        session.clear()
        session["user_id"] = user_id
        session["role"] = role
        session["authenticated_at"] = time.time()
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
        session["authenticated_at"] = time.time()
        if not current_app.config.get("TESTING"):
            from ..privacy import PRIVACY_NOTICE_VERSION

            notice = get_db().execute(
                "SELECT privacy_notice_version FROM users WHERE id = ?",
                (principal.id,),
            ).fetchone()
            if not notice or notice["privacy_notice_version"] != PRIVACY_NOTICE_VERSION:
                session["privacy_notice_pending"] = True
                return redirect(url_for("privacy_acknowledge", next=_next_url()))
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

    @app.before_request
    def reject_token_management_without_account():
        if request.path.startswith("/auth/tokens") and current_principal().authenticated:
            if current_principal().id is None:
                return _auth_failure("token management requires a database account", 403)
        return None

    @app.get("/auth/tokens")
    @login_required
    def auth_tokens():
        tokens = _tokens_for_user(int(current_principal().id))
        if _wants_json():
            return jsonify({"ok": True, "tokens": tokens})
        return render_template("auth_tokens.html", tokens=tokens)

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
        response = _token_response(int(cursor.lastrowid), label, token)
        if request.is_json or _wants_json():
            return jsonify(response)
        return render_template(
            "auth_tokens.html",
            tokens=_tokens_for_user(int(principal.id)),
            created_token=token,
        )

    @app.patch("/auth/tokens/<int:token_id>")
    @login_required
    def auth_update_token(token_id: int):
        data = request.get_json(silent=True) or {}
        label = str(data.get("label") or "").strip()[:80]
        if not label:
            return jsonify({"ok": False, "error": "label is required"}), 400
        cursor = get_db().execute(
            "UPDATE api_tokens SET label = ? WHERE id = ? AND user_id = ?",
            (label, token_id, current_principal().id),
        )
        get_db().commit()
        if cursor.rowcount == 0:
            return jsonify({"ok": False, "error": "token not found"}), 404
        return jsonify({"ok": True, "id": token_id, "label": label})

    @app.post("/auth/tokens/<int:token_id>/update")
    @login_required
    def auth_update_token_form(token_id: int):
        label = request.form.get("label", "").strip()[:80]
        if not label:
            flash("Token label is required.")
        else:
            cursor = get_db().execute(
                "UPDATE api_tokens SET label = ? WHERE id = ? AND user_id = ?",
                (label, token_id, current_principal().id),
            )
            get_db().commit()
            flash("Token updated." if cursor.rowcount else "Token not found.")
        return redirect(url_for("auth_tokens"))

    @app.delete("/auth/tokens/<int:token_id>")
    @login_required
    def auth_delete_token(token_id: int):
        cursor = get_db().execute(
            "DELETE FROM api_tokens WHERE id = ? AND user_id = ?",
            (token_id, current_principal().id),
        )
        get_db().commit()
        return jsonify({"ok": cursor.rowcount > 0})

    @app.post("/auth/tokens/<int:token_id>/revoke")
    @login_required
    def auth_delete_token_form(token_id: int):
        cursor = get_db().execute(
            "DELETE FROM api_tokens WHERE id = ? AND user_id = ?",
            (token_id, current_principal().id),
        )
        get_db().commit()
        flash("Token revoked." if cursor.rowcount else "Token not found.")
        return redirect(url_for("auth_tokens"))

    register_ldap_adapter(app)
    register_saml_adapter(app)
    register_oidc_adapter(app)
