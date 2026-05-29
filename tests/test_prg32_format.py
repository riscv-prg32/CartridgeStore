from __future__ import annotations

import binascii
import struct

import pytest

from cartridge_store import prg32_format as fmt


PNG_1X1 = (
    b"\x89PNG\r\n\x1a\n"
    b"\x00\x00\x00\rIHDR"
    b"\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x02\x00\x00\x00\x90wS\xde"
    b"\x00\x00\x00\x0cIDATx\x9cc```\x00\x00\x00\x04\x00\x01"
    b"\xf6\x178U\x00\x00\x00\x00IEND\xaeB`\x82"
)

JPEG_TINY = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9"


def fake_cart() -> bytes:
    code = b"\x13\x00\x00\x00" * 3
    crc = binascii.crc32(code) & 0xffffffff
    header = struct.pack(
        "<4sHHHHIIIIIII32s",
        b"PRG2",
        1,
        0,
        fmt.CART_HEADER.size,
        0,
        0x40380000,
        len(code),
        len(code),
        0,
        4,
        8,
        crc,
        b"test" + b"\0" * 28,
    )
    return header + code


def metadata() -> dict:
    return {
        "abi": "prg32-metadata-1.0",
        "id": "org.example.test",
        "title": "Test Game",
        "version": "1.0.0",
        "authors": [{"name": "PRG32"}],
        "tags": ["test"],
    }


def colophon() -> dict:
    return {
        "abi": "prg32-colophon-1.0",
        "title": "Test Game",
        "version": "1.0.0",
        "developer": {"name": "PRG32"},
        "authors": [],
        "controls": [],
    }


def test_build_and_parse_all_known_blocks() -> None:
    image = fmt.build_cartridge(
        fake_cart(),
        metadata=metadata(),
        icon=PNG_1X1,
        screenshot=JPEG_TINY,
        signature={"algorithm": "none"},
        colophon=colophon(),
        architecture="esp32c6",
    )
    parsed = fmt.parse_cartridge(image)

    assert parsed.trailer_present
    assert parsed.metadata["runtime"]["architecture"] == "esp32c6"
    assert parsed.icon == PNG_1X1
    assert parsed.screenshot == JPEG_TINY
    assert parsed.signature_json["algorithm"] == "none"
    assert parsed.colophon["developer"]["name"] == "PRG32"


def test_legacy_without_trailer() -> None:
    parsed = fmt.parse_cartridge(fake_cart())

    assert not parsed.trailer_present
    assert parsed.legacy_payload == fake_cart()
    assert parsed.blocks == ()


def test_malformed_trailer_fails() -> None:
    with pytest.raises(fmt.CartridgeFormatError):
        fmt.parse_cartridge(fake_cart() + b"PRG32META")


def test_unknown_tlv_blocks_are_preserved() -> None:
    unknown = fmt.TrailerBlock("X999", b"opaque")
    existing = fake_cart() + fmt.build_trailer([unknown])

    rebuilt = fmt.build_cartridge(
        existing,
        metadata=metadata(),
        icon=PNG_1X1,
        colophon=colophon(),
        architecture="qemu",
    )

    assert fmt.parse_cartridge(rebuilt).unknown_blocks == (unknown,)


def test_colophon_required_fields() -> None:
    with pytest.raises(fmt.ColophonValidationError):
        fmt.validate_colophon(
            {
                "abi": "prg32-colophon-1.0",
                "title": "Broken",
                "version": "1.0.0",
                "authors": [],
                "controls": [],
            }
        )
