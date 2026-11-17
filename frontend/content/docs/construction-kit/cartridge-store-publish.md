---
title: Publish to the Cartridge Store
---

# Publishing to Cartridge Store

## Bundle shape

PRG32-Construction-Kit prepares a zip bundle shaped for Cartridge Store:

```text
manifest.json
icon.png
<game>-esp32c6.prg32
<game>-qemu.prg32
source/game.c
source/project.blocks.json
source/game.ir.json
```

The `source/` directory is extra teaching material. Cartridge Store uses the manifest and `.prg32` files.

## Configure a publish profile

Open **Publish** and create a profile:

```text
Name: Local Cartridge Store
URL:  https://api.prg32.test
Token: optional bearer token
```

The token is write-only: after you save it, the kit only shows "token saved"
and never sends the token back to the browser. To change it, create a new
profile (or `PUT /api/publish_profiles/<id>` with a new `bearer_token`).

Only bundles stored in the kit's own data folders can be downloaded or
published; an artifact whose `path` points elsewhere is treated as missing.

When the kit is linked with the Cartridge Store (`accounts_and_sso.md`), a
profile whose address is `PRG32_SSO_PEER_URL` needs no token: the kit sends a
one-time ticket and the bundle is published as the signed-in student.

## Publish flow

1. Open a project.
2. Click **Compile Cartridge** so the bundle contains both architectures (**Download .prg32** builds only one).
3. Open **Publish**.
4. Select the store profile.
5. Click **Publish** on a store bundle.

The backend sends:

```http
POST /api/publish/bundle
Content-Type: multipart/form-data
Authorization: Bearer <token>

bundle=@game-store-bundle.zip
```

## Review behavior

A Cartridge Store may accept the upload as a pending submission rather than immediately publishing it. Teachers/editors review and verify submissions in Cartridge Store.
