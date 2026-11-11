#!/usr/bin/env python3
"""Create a deterministic scanned engineering-sheet PDF for OCR integration tests."""
import sys
from PIL import Image, ImageDraw, ImageFont

out = sys.argv[1]
image = Image.new("RGB", (1800, 1300), "white")
draw = ImageDraw.Draw(image)
font_path = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
title = ImageFont.truetype(font_path, 76)
body = ImageFont.truetype(font_path, 62)
small = ImageFont.truetype(font_path, 48)
draw.rectangle((70, 70, 1730, 1230), outline="black", width=7)
draw.text((150, 130), "MMC ENGINEERING DRAWING", font=title, fill="black")
draw.line((140, 250, 1660, 250), fill="black", width=5)
draw.text((160, 340), "GROUND FLOOR PLAN", font=title, fill="black")
draw.text((160, 520), "GRID A - B", font=body, fill="black")
draw.text((160, 650), "DIMENSION 6000 mm", font=body, fill="black")
draw.text((160, 780), "CONCRETE C30", font=body, fill="black")
draw.text((160, 910), "DRAWING NO S-101", font=body, fill="black")
draw.text((160, 1080), "SCALE 1:100  REV 02", font=small, fill="black")
image.save(out, "PDF", resolution=200.0)
