"""Annotate demo screenshot with callouts (exact Vietnamese text)."""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "assets" / "demo-screenshot-original.png"
OUT = ROOT / "assets" / "demo-screenshot.png"


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    names = (
        ["segoeuib.ttf", "arialbd.ttf"] if bold else ["segoeui.ttf", "arial.ttf", "tahoma.ttf", "calibri.ttf"]
    )
    windir = Path(r"C:\Windows\Fonts")
    for name in names:
        p = windir / name
        if p.exists():
            return ImageFont.truetype(str(p), size)
    return ImageFont.load_default()


def draw_arrow(draw: ImageDraw.ImageDraw, start, end, color, width=4, head=14) -> None:
    x0, y0 = start
    x1, y1 = end
    draw.line([x0, y0, x1, y1], fill=color, width=width)
    ang = math.atan2(y1 - y0, x1 - x0)
    p1 = (x1 - head * math.cos(ang - 0.45), y1 - head * math.sin(ang - 0.45))
    p2 = (x1 - head * math.cos(ang + 0.45), y1 - head * math.sin(ang + 0.45))
    draw.polygon([end, p1, p2], fill=color)


def rounded_label(draw, box, text, font, fill, outline, text_color, shadow=True) -> None:
    x0, y0, x1, y1 = box
    if shadow:
        draw.rounded_rectangle([x0 + 3, y0 + 4, x1 + 3, y1 + 4], radius=12, fill=(0, 0, 0, 55))
    draw.rounded_rectangle(box, radius=12, fill=fill, outline=outline, width=3)
    bbox = draw.multiline_textbbox((0, 0), text, font=font, spacing=4, align="center")
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = x0 + (x1 - x0 - tw) // 2
    ty = y0 + (y1 - y0 - th) // 2
    draw.multiline_text((tx, ty), text, font=font, fill=text_color, spacing=4, align="center")


def main() -> None:
    im = Image.open(SRC).convert("RGBA")
    overlay = Image.new("RGBA", im.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)

    f_body = load_font(16, bold=True)
    f_small = load_font(14, bold=True)

    # VALUE column region (approx for 880x687 capture)
    value_x = 448
    value_top = 68
    value_bot = 338
    bracket_x = value_x + 34

    # 1) Main callout → input boxes
    bubble1 = (505, 100, 760, 188)
    rounded_label(
        d,
        bubble1,
        "Gõ vào đây\nđể nhập điểm",
        f_body,
        fill=(15, 23, 42, 250),
        outline=(56, 189, 248, 255),
        text_color=(255, 255, 255, 255),
    )

    # Vertical bracket along Value column
    blue = (56, 189, 248, 235)
    d.line([(bracket_x, value_top), (bracket_x, value_bot)], fill=blue, width=4)
    d.line([(bracket_x - 12, value_top), (bracket_x, value_top)], fill=blue, width=4)
    d.line([(bracket_x - 12, value_bot), (bracket_x, value_bot)], fill=blue, width=4)

    mid_y = (bubble1[1] + bubble1[3]) // 2
    draw_arrow(d, (bubble1[0], mid_y), (bracket_x + 2, mid_y), (56, 189, 248, 255), width=5, head=16)

    for y in (78, 120, 165, 215, 265, 315):
        draw_arrow(d, (bracket_x, y), (value_x + 10, y), (56, 189, 248, 210), width=3, head=9)

    # 2) Average auto-calc — dưới STATUS, không đè chữ STUDYING
    bubble2 = (48, 455, 280, 520)
    rounded_label(
        d,
        bubble2,
        "Tự tính Average",
        f_small,
        fill=(6, 78, 59, 245),
        outline=(74, 222, 128, 255),
        text_color=(255, 255, 255, 255),
    )
    # Mũi tên chỉ vào số 9.1
    draw_arrow(d, (bubble2[0] + 120, bubble2[1] + 2), (268, 378), (74, 222, 128, 255), width=4, head=12)

    # 3) GPA panel — nhãn dưới panel, mũi tên lên
    bubble3 = (500, 620, 780, 678)
    # clamp if image shorter
    if bubble3[3] > im.size[1] - 4:
        dy = bubble3[3] - (im.size[1] - 8)
        bubble3 = (bubble3[0], bubble3[1] - dy, bubble3[2], bubble3[3] - dy)
    rounded_label(
        d,
        bubble3,
        "GPA cả kỳ (session)",
        f_small,
        fill=(30, 58, 138, 250),
        outline=(96, 165, 250, 255),
        text_color=(255, 255, 255, 255),
    )
    draw_arrow(
        d,
        ((bubble3[0] + bubble3[2]) // 2, bubble3[1] + 2),
        (740, 500),
        (96, 165, 250, 255),
        width=4,
        head=12,
    )

    out = Image.alpha_composite(im, overlay).convert("RGB")
    out.save(OUT, "PNG", optimize=True)
    print(f"Wrote {OUT} ({out.size[0]}x{out.size[1]})")


if __name__ == "__main__":
    main()
