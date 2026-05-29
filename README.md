# PRG32 Cartrige Store

An installable Flask/PWA catalog for PRG32 `.prg32` game cartridges. Developers
can upload a legacy cartridge plus metadata, icon, optional screenshot,
signature, and colophon; the server publishes a monolithic `PRG32META`
cartridge artifact for firmware and QEMU clients to download.

The server name is **Cartrige Store**. The file format remains PRG32
"cartridge" terminology.

## Run

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open <http://127.0.0.1:5080/>.

Set `PRG32_STORE_DATA=/path/to/data` to move filesystem storage. By default the
store writes cartridges to `data/cartridges` and the extracted index to
`data/index.json`.

## Versioning and Architectures

A `.prg32` file contains one linked executable image. The store groups uploads
by metadata `id` and `version`, and then stores one artifact per architecture:

- `esp32c6`: physical ESP32-C6 PRG32 firmware.
- `qemu`: ESP32-C3 QEMU RGB screen workflow.

Download endpoints accept `version` and `architecture` query parameters:

```http
GET /api/games/org.example.game/download?version=1.0.0&architecture=esp32c6
```

## REST API

| Method | Path |
| --- | --- |
| `GET` | `/api/games` |
| `GET` | `/api/games/<id>` |
| `GET` | `/api/games/<id>/icon` |
| `GET` | `/api/games/<id>/screenshot` |
| `GET` | `/api/games/<id>/colophon` |
| `GET` | `/api/games/<id>/download` |
| `POST` | `/api/publish` |
| `GET` | `/.well-known/prg32-store.json` |

`POST /api/publish` accepts `multipart/form-data` with:

- `cartridge`: legacy or already-monolithic `.prg32`.
- `metadata`: optional `prg32-metadata-1.0` JSON object. If omitted, form
  fields such as `id`, `title`, `version`, `summary`, and `tags` are used.
- `icon`: PNG or JPEG icon.
- `screenshot`: optional PNG or JPEG screenshot.
- `signature`: optional bytes or JSON signature object.
- `colophon`: optional `prg32-colophon-1.0` JSON object. If omitted, colophon
  form fields are used.
- `architecture`: `esp32c6` or `qemu`.

## Compatibility and Safety

- The store never executes uploaded cartridge code.
- Upload size is limited by Flask `MAX_CONTENT_LENGTH`.
- Game IDs and versions are restricted to path-safe characters.
- Metadata and colophon JSON are validated before publishing.
- Icon and screenshot uploads must be PNG or JPEG bytes.
- Unknown metadata trailer TLV blocks are preserved when rewriting a cartridge.
- The game colophon is shown after the cartridge is activated, before the player
  starts a new play.

## Tests

```bash
pytest -q
```
