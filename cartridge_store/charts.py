"""Tiny dependency-free SVG chart helpers."""

from __future__ import annotations

from html import escape
from typing import Any


def _num(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _color(value: str) -> str:
    text = str(value or "").strip()
    if len(text) in (4, 7) and text.startswith("#"):
        return text
    return "#1a73e8"


def line_chart(
    series: list[dict],
    *,
    width: int = 600,
    height: int = 200,
    x_label: str = "",
    y_label: str = "",
    color: str = "#1a73e8",
    title: str = "",
    reference_lines: list[dict] | None = None,
) -> str:
    title = title or y_label or "Line chart"
    width = max(width, 240)
    height = max(height, 140)
    pad_left = 48
    pad_right = 18
    pad_top = 26
    pad_bottom = 34
    plot_w = width - pad_left - pad_right
    plot_h = height - pad_top - pad_bottom
    points = [{"x": i, "y": _num(item.get("y"))} for i, item in enumerate(series)]
    if not points:
        points = [{"x": 0, "y": 0}]
    ys = [point["y"] for point in points]
    for line in reference_lines or []:
        ys.append(_num(line.get("y")))
    min_y = min(0.0, min(ys))
    max_y = max(1.0, max(ys))
    span_y = max(max_y - min_y, 1.0)
    span_x = max(len(points) - 1, 1)

    def px(index: int) -> float:
        return pad_left + (index / span_x) * plot_w

    def py(value: float) -> float:
        return pad_top + plot_h - ((value - min_y) / span_y) * plot_h

    path = " ".join(
        f"{'M' if index == 0 else 'L'} {px(index):.2f} {py(point['y']):.2f}"
        for index, point in enumerate(points)
    )
    parts = [
        f'<svg viewBox="0 0 {width} {height}" role="img" aria-labelledby="chart-title" xmlns="http://www.w3.org/2000/svg">',
        f"<title id=\"chart-title\">{escape(title)}</title>",
        f'<rect width="{width}" height="{height}" fill="white"/>',
        f'<line x1="{pad_left}" y1="{pad_top}" x2="{pad_left}" y2="{height - pad_bottom}" stroke="#b8c2cc"/>',
        f'<line x1="{pad_left}" y1="{height - pad_bottom}" x2="{width - pad_right}" y2="{height - pad_bottom}" stroke="#b8c2cc"/>',
    ]
    for line in reference_lines or []:
        value = _num(line.get("y"))
        y = py(value)
        label = escape(str(line.get("label", "")))
        parts.append(f'<line x1="{pad_left}" y1="{y:.2f}" x2="{width - pad_right}" y2="{y:.2f}" stroke="#94a3b8" stroke-dasharray="4 3"/>')
        if label:
            parts.append(f'<text x="{width - pad_right}" y="{y - 4:.2f}" text-anchor="end" font-size="11" fill="#475569">{label}</text>')
    parts.extend(
        [
            f'<path d="{path}" fill="none" stroke="{_color(color)}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>',
            f'<text x="{pad_left}" y="{height - 8}" font-size="11" fill="#475569">{escape(x_label)}</text>',
            f'<text x="12" y="{pad_top}" font-size="11" fill="#475569">{escape(y_label)}</text>',
            "</svg>",
        ]
    )
    return "".join(parts)


def bar_chart(
    items: list[tuple],
    *,
    width: int = 600,
    height: int = 300,
    color: str = "#1a73e8",
    title: str = "",
) -> str:
    title = title or "Bar chart"
    width = max(width, 260)
    height = max(height, 120)
    pad_left = 130
    pad_right = 72
    pad_top = 28
    row_h = 24
    chart_h = max(height, pad_top + 24 + row_h * max(len(items), 1))
    plot_w = width - pad_left - pad_right
    values = [_num(value) for _, value in items]
    max_value = max(values) if values else 1.0
    if max_value <= 0:
        max_value = 1.0
    parts = [
        f'<svg viewBox="0 0 {width} {chart_h}" role="img" aria-labelledby="bar-title" xmlns="http://www.w3.org/2000/svg">',
        f"<title id=\"bar-title\">{escape(title)}</title>",
        f'<rect width="{width}" height="{chart_h}" fill="white"/>',
    ]
    if not items:
        parts.append('<text x="16" y="54" font-size="14" fill="#64748b">No data</text>')
    for index, (label, value) in enumerate(items):
        number = _num(value)
        y = pad_top + index * row_h
        bar_w = max(0.0, (number / max_value) * plot_w)
        parts.extend(
            [
                f'<text x="{pad_left - 8}" y="{y + 16}" text-anchor="end" font-size="12" fill="#334155">{escape(str(label))}</text>',
                f'<rect x="{pad_left}" y="{y + 4}" width="{bar_w:.2f}" height="14" rx="3" fill="{_color(color)}"/>',
                f'<text x="{pad_left + bar_w + 6:.2f}" y="{y + 16}" font-size="12" fill="#334155">{int(number) if number.is_integer() else number:.0f}</text>',
            ]
        )
    parts.append("</svg>")
    return "".join(parts)
