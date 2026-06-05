"""Best-effort mDNS advertisement for the local store."""

from __future__ import annotations

import atexit
import logging
import os
import socket

from flask import Flask


log = logging.getLogger(__name__)


def register_mdns(app: Flask) -> None:
    if app.config.get("TESTING"):
        return
    if os.environ.get("PRG32_MDNS_DISABLED", "").lower() in {"1", "true", "yes"}:
        return
    try:
        from zeroconf import ServiceInfo, Zeroconf
    except Exception as exc:  # pragma: no cover - optional dependency path
        log.warning("mDNS advertisement disabled because zeroconf is not installed: %s", exc)
        return

    service_type = os.environ.get("PRG32_MDNS_TYPE", "_http._tcp.local.")
    instance = os.environ.get("PRG32_MDNS_NAME", app.config["STORE_NAME"])
    if not instance.endswith("." + service_type):
        service_name = f"{instance}.{service_type}"
    else:
        service_name = instance
    port = int(os.environ.get("PRG32_MDNS_PORT", "5080"))
    addresses = _local_addresses()
    if not addresses:
        log.warning("mDNS advertisement disabled because no IPv4 address was found")
        return
    info = ServiceInfo(
        service_type,
        service_name,
        addresses=addresses,
        port=port,
        properties={
            "path": "/",
            "api": "/api",
            "discovery": "/.well-known/prg32-store.json",
        },
        server=_local_hostname(),
    )
    zeroconf = Zeroconf()
    try:
        zeroconf.register_service(info)
    except Exception as exc:  # pragma: no cover - network environment dependent
        zeroconf.close()
        log.warning("mDNS advertisement failed: %s", exc)
        return
    app.extensions["prg32_mdns"] = {"zeroconf": zeroconf, "info": info}
    atexit.register(_close_mdns, zeroconf, info)
    log.info("Advertising %s via mDNS on port %s", service_name, port)


def _local_hostname() -> str:
    hostname = socket.gethostname().split(".")[0] or "prg32-cartrige-store"
    return f"{hostname}.local."


def _local_addresses() -> list[bytes]:
    addresses: list[bytes] = []
    try:
        infos = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
    except socket.gaierror:
        infos = []
    for info in infos:
        address = info[4][0]
        if address.startswith("127."):
            continue
        packed = socket.inet_aton(address)
        if packed not in addresses:
            addresses.append(packed)
    if addresses:
        return addresses
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 80))
        address = probe.getsockname()[0]
        probe.close()
        if not address.startswith("127."):
            return [socket.inet_aton(address)]
    except OSError:
        pass
    return []


def _close_mdns(zeroconf, info) -> None:
    try:
        zeroconf.unregister_service(info)
    except Exception:
        pass
    zeroconf.close()
