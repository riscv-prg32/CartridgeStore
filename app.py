#!/usr/bin/env python3
"""Run the PRG32 Cartridge Store development server."""

from cartridge_store import create_app


app = create_app()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5080, debug=True, use_reloader=False)
