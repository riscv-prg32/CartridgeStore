from pathlib import Path


def test_dev_topology_has_only_fastify_and_next_services() -> None:
    compose = (Path(__file__).parents[1] / "docker-compose.yml").read_text()

    assert "  backend:" in compose
    assert "  next:" in compose
    lines = compose.splitlines()
    service_start = lines.index("services:") + 1
    network_start = next(index for index, line in enumerate(lines) if line == "networks:")
    service_names = {
        line.strip().removesuffix(":")
        for line in lines[service_start:network_start]
        if line.startswith("  ") and not line.startswith("    ") and line.endswith(":")
    }
    assert service_names == {"backend", "next"}
