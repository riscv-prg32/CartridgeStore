#!/usr/bin/env python3
"""Run the PRG32 Cartrige Store development server."""

from cartridge_store import create_app


app = create_app()


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5080, debug=True)
