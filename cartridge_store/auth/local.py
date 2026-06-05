"""Local username/password authentication."""

from __future__ import annotations

import re
from typing import Any

from werkzeug.security import check_password_hash, generate_password_hash

from ..database import get_db
from . import ANONYMOUS, Principal, normalize_role, principal_from_row


USERNAME_RE = re.compile(r"^[A-Za-z0-9_-]{3,40}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def validate_registration(form: Any) -> list[str]:
    errors: list[str] = []
    username = str(form.get("username", "")).strip()
    email = str(form.get("email", "")).strip()
    password = str(form.get("password", ""))
    if not USERNAME_RE.fullmatch(username):
        errors.append("username must be 3-40 letters, digits, underscores, or dashes")
    if not EMAIL_RE.fullmatch(email):
        errors.append("email must be valid")
    if len(password) < 10:
        errors.append("password must be at least 10 characters")
    return errors


def create_local_user(username: str, email: str, password: str, *, role: str = "user") -> int:
    db = get_db()
    cursor = db.execute(
        """
        INSERT INTO users(username, email, password_hash, role)
        VALUES (?, ?, ?, ?)
        """,
        (
            username.strip(),
            email.strip().lower(),
            generate_password_hash(password),
            normalize_role(role),
        ),
    )
    db.commit()
    return int(cursor.lastrowid)


def authenticate_local_user(username: str, password: str) -> Principal:
    row = get_db().execute(
        """
        SELECT *
        FROM users
        WHERE username = ? OR email = ?
        """,
        (username.strip(), username.strip().lower()),
    ).fetchone()
    if row is None or not row["password_hash"]:
        return ANONYMOUS
    if not check_password_hash(str(row["password_hash"]), password):
        return ANONYMOUS
    return principal_from_row(row)
