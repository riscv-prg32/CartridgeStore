"""Gunicorn settings for PRG32 Cartridge Store.

Every open multiplayer WebSocket keeps one gunicorn thread busy for as long
as the board stays connected. With only a handful of threads, a single full
game room would leave no thread for HTTP requests and the whole store would
stop answering. Run many threads instead.

Multiplayer rooms live in process memory, so keep exactly one worker process:
with several workers, players of the same game could land in different rooms.
"""

import os


bind = os.environ.get("PRG32_BIND", "0.0.0.0:5080")
workers = 1
worker_class = "gthread"
threads = int(os.environ.get("PRG32_THREADS", "128"))
timeout = 120
