# Accounts and Single Sign-On with PRG32-Construction-Kit

The Cartridge Store and a PRG32-Construction-Kit can share their users. When
the option is turned on **on both sides**:

- a user created on one side is created on the other one (registration,
  the admin Users page, or OIDC/SAML sign-in);
- changing a password, email, role or groups on one side changes it on the
  other one;
- deleting a user on one side deletes it on the other one;
- **Construction Kit** in the store menu (and **Cartridge Store** in the kit)
  signs the user in on the other side without a second password;
- the kit publishes cartridges here as the signed-in student, with a one-time
  ticket instead of a stored token.

## Turning it on

Pick a long random secret once:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

Give both services the **same secret** and **each other's address**:

```bash
# Cartridge Store
export PRG32_SSO_SECRET="the-same-long-secret"
export PRG32_SSO_PEER_URL="http://kit.school.lan:5090"

# Construction Kit
export PRG32_SSO_SECRET="the-same-long-secret"
export PRG32_SSO_PEER_URL="http://store.school.lan:5080"
```

Restart both, sign in to either one as an admin, open **Users** and press
**Sync now** once. That copies the accounts that existed before. After that,
changes are sent right away.

Both services start with an `admin@localhost` account. Once linked they are
the same account, with the password that was changed most recently. Change
the admin password on one side after the first sync, and use that password on
both.

## How it works

- **Same email = same person.** Accounts are matched by email.
- **Newest change wins.** `users.updated_at` records when an account last
  changed; an older change never overwrites a newer one.
- **Passwords are copied as hashes**, never as plain text.
- **Signed requests.** Every request to `/api/sso/users` carries an HMAC
  signature of its body and the time; requests older than 5 minutes are
  refused.
- **Tickets** name the user's email and the service they are for, expire after
  60 seconds (sign-in) or 120 seconds (publishing), and work only once.
- **Offline is fine.** If the kit cannot be reached, the change waits in the
  `sso_outbox` table and goes out with the next change or the next
  **Sync now**.
- **The last admin is safe.** A synced change never deletes or demotes the last
  admin.
- API tokens and legacy `PRG32_USERS` tokens are **not** shared.

The protocol is in `cartridge_store/sso_protocol.py`, which must stay
identical to `prg32_construction_kit/sso_protocol.py` in the Construction Kit.

## Safety notes

- Use **HTTPS** between the services outside a closed classroom network:
  synced records carry password hashes.
- Anyone who knows the secret can create admin accounts on both sides. Keep it
  like a password, and change it on both sides if it leaks.
- Linking means an admin on one side is an admin on the other side too.
