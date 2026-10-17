"""PRG32 SSO protocol shared by PRG32-Construction-Kit and Cartridge Store.

This file is kept identical in both repositories. It only does signing and
checking; each app stores users in its own database.

How the two services trust each other
-------------------------------------
Both services are given the same secret (``PRG32_SSO_SECRET``) and each
other's address (``PRG32_SSO_PEER_URL``). Nothing else is shared.

1. **User sync.** When a user is created, changed or deleted on one side, that
   side sends the user record to the other side's ``/api/sso/users``. The
   request is signed with an HMAC of the body, so only a service that knows the
   secret can create users. The newest change (``updated_at``) wins.

2. **Login tickets.** A signed-in user can jump to the other service without
   typing the password again. The service makes a short-lived ticket naming the
   user's email and the service it is meant for; the other service checks the
   signature, the audience, the expiry and that the ticket was never used.

3. **API tickets.** The Construction Kit publishes cartridges to the Cartridge
   Store as the signed-in student by sending a one-time API ticket as the bearer
   token.

Use HTTPS between the services: synced records carry password *hashes*.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from datetime import datetime, timezone
from typing import Any

SSO_ABI = "prg32-sso-1.0"
TICKET_PREFIX = "sso1."
USERS_PATH = "/api/sso/users"
ACCEPT_PATH = "/auth/sso/accept"
MIN_SECRET_LENGTH = 32
MAX_CLOCK_SKEW_SECONDS = 300
LOGIN_TICKET_SECONDS = 60
API_TICKET_SECONDS = 120

AUDIENCE_KIT = "construction-kit"
AUDIENCE_STORE = "cartridge-store"
ROLES = ("reader", "user", "player", "publisher", "admin")


def secret_is_usable(secret: str | None) -> bool:
    return bool(secret) and len(str(secret)) >= MIN_SECRET_LENGTH


def _key(secret: str, purpose: str) -> bytes:
    """Use a different key for each job so a signature for one job is useless for another."""
    return hmac.new(secret.encode("utf-8"), f"{SSO_ABI}:{purpose}".encode("utf-8"), hashlib.sha256).digest()


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def timestamp_now() -> str:
    """UTC time with microseconds, the format used for ``updated_at`` in synced records."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def parse_timestamp(value: Any) -> datetime:
    """Read an ``updated_at`` value; missing or unreadable values count as very old."""
    text = str(value or "").strip()
    if not text:
        return datetime.min.replace(tzinfo=timezone.utc)
    text = text.replace(" ", "T")
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def is_newer(incoming: Any, local: Any) -> bool:
    """True when the incoming change is at least as new as the local one."""
    return parse_timestamp(incoming) >= parse_timestamp(local)


# --- signed requests between the two services --------------------------------

def sign_request(secret: str, method: str, path: str, body: bytes, timestamp: int | None = None) -> dict[str, str]:
    """Headers that prove this request comes from a service that knows the secret."""
    ts = str(int(time.time() if timestamp is None else timestamp))
    digest = hashlib.sha256(body).hexdigest()
    message = f"{ts}\n{method.upper()}\n{path}\n{digest}".encode("utf-8")
    signature = hmac.new(_key(secret, "request"), message, hashlib.sha256).hexdigest()
    return {"X-PRG32-SSO-Timestamp": ts, "X-PRG32-SSO-Signature": signature}


def verify_request(secret: str, method: str, path: str, body: bytes, headers: Any, now: float | None = None) -> bool:
    ts = str(headers.get("X-PRG32-SSO-Timestamp", "")).strip()
    signature = str(headers.get("X-PRG32-SSO-Signature", "")).strip()
    if not ts.isdigit() or not signature:
        return False
    current = time.time() if now is None else now
    if abs(current - int(ts)) > MAX_CLOCK_SKEW_SECONDS:
        return False
    expected = sign_request(secret, method, path, body, int(ts))["X-PRG32-SSO-Signature"]
    return hmac.compare_digest(expected, signature)


# --- tickets ------------------------------------------------------------------

def make_ticket(secret: str, *, email: str, audience: str, purpose: str, ttl: int, now: float | None = None) -> str:
    """A one-time, short-lived, signed note: "this email is signed in, for that service"."""
    issued = int(time.time() if now is None else now)
    claims = {
        "abi": SSO_ABI,
        "email": str(email).strip().lower(),
        "aud": audience,
        "purpose": purpose,
        "iat": issued,
        "exp": issued + int(ttl),
        "nonce": secrets.token_urlsafe(18),
    }
    payload = _b64(json.dumps(claims, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signature = _b64(hmac.new(_key(secret, "ticket"), payload.encode("ascii"), hashlib.sha256).digest())
    return f"{TICKET_PREFIX}{payload}.{signature}"


def read_ticket(secret: str, ticket: str, *, audience: str, purpose: str, now: float | None = None) -> dict[str, Any] | None:
    """Return the ticket claims if the ticket is genuine, unexpired and meant for us.

    The caller must still check that ``claims["nonce"]`` was never used before.
    """
    text = str(ticket or "").strip()
    if not text.startswith(TICKET_PREFIX):
        return None
    try:
        payload, signature = text[len(TICKET_PREFIX):].split(".", 1)
        expected = _b64(hmac.new(_key(secret, "ticket"), payload.encode("ascii"), hashlib.sha256).digest())
        if not hmac.compare_digest(expected, signature):
            return None
        claims = json.loads(_unb64(payload))
    except (ValueError, TypeError, json.JSONDecodeError):
        return None
    if not isinstance(claims, dict):
        return None
    current = time.time() if now is None else now
    if claims.get("abi") != SSO_ABI or claims.get("aud") != audience or claims.get("purpose") != purpose:
        return None
    if not isinstance(claims.get("exp"), int) or claims["exp"] < current:
        return None
    if not claims.get("email") or not claims.get("nonce"):
        return None
    return claims


# --- user records -------------------------------------------------------------

def clean_record(data: Any) -> dict[str, Any]:
    """Check one synced user record and keep only the fields both services understand."""
    if not isinstance(data, dict):
        raise ValueError("user record must be a JSON object")
    email = str(data.get("email") or "").strip().lower()
    if "@" not in email or len(email) > 254:
        raise ValueError("user record needs a valid email")
    record: dict[str, Any] = {
        "email": email,
        "updated_at": str(data.get("updated_at") or ""),
        "deleted": bool(data.get("deleted")),
        "previous_email": str(data.get("previous_email") or "").strip().lower() or None,
    }
    if record["deleted"]:
        return record
    role = str(data.get("role") or "user").strip().lower()
    if role not in ROLES:
        raise ValueError(f"unknown role: {role!r}")
    groups = data.get("groups") or []
    if not isinstance(groups, list):
        raise ValueError("groups must be a list")
    password_hash = data.get("password_hash")
    record.update(
        username=str(data.get("username") or email).strip()[:120] or email,
        role=role,
        groups=sorted({str(group).strip().lower()[:80] for group in groups if str(group).strip()}),
        password_hash=str(password_hash) if password_hash else None,
    )
    return record
