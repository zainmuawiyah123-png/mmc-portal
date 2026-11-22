import asyncio, pathlib
from playwright.async_api import async_playwright

# Render a vector plan to PDF using Chromium's print-to-PDF, so pdf.js can extract
# real linework (not a raster image).
SVG = """<!doctype html><meta charset=utf-8><style>
@page{{size:420mm 297mm;margin:0}}html,body{{margin:0}}
svg{{width:420mm;height:297mm;background:#fff}}
line,polyline,rect,circle,arc{{stroke:#111;fill:none;stroke-width:2}}
</style><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2000 1400">
<!-- grid -->
{g}
<!-- slab outline + interior -->
<rect x="200" y="200" width="1000" height="600"/>
<!-- columns 5x4 -->
{c}
<!-- beams -->
{b}
<!-- footings -->
{f}
<!-- walls -->
<rect x="200" y="200" width="1000" height="600"/>
<line x1="600" y1="200" x2="600" y2="800"/>
<line x1="200" y1="500" x2="1200" y2="500"/>
<!-- doors -->
{d}
<!-- windows -->
{w}
<!-- lighting -->
{l}
<!-- outlets -->
{o}
<!-- ducts -->
{u}
<!-- pipes -->
{p}
</svg>"""


def build():
    g = "".join(f'<line x1="{200+200*i}" y1="180" x2="{200+200*i}" y2="820"/>' for i in range(6))
    g += "".join(f'<line x1="180" y1="{200+150*j}" x2="1220" y2="{200+150*j}"/>' for j in range(5))
    c = "".join(f'<rect x="{200+200*i-15}" y="{200+150*j-15}" width="30" height="30"/>'
                for i in range(6) for j in range(5))
    b = "".join(f'<line x1="200" y1="{200+150*j}" x2="1200" y2="{200+150*j}"/>' for j in range(5))
    b += "".join(f'<line x1="{200+200*i}" y1="200" x2="{200+200*i}" y2="800"/>' for i in range(6))
    f = "".join(f'<rect x="{200+200*i-40}" y="{200+150*j-40}" width="80" height="80"/>'
                for i in range(6) for j in range(5))
    d = "".join(f'<line x1="{350+200*i}" y1="200" x2="{350+200*i}" y2="240"/>'
                f'<path d="M{350+200*i} 240 a40 40 0 0 1 40 -40"/>' for i in range(3))
    w = "".join(f'<rect x="{260+240*i}" y="192" width="60" height="16"/>'
                f'<rect x="{260+240*i}" y="792" width="60" height="16"/>' for i in range(4))
    l = "".join(f'<circle cx="{300+200*i}" cy="{275+150*j}" r="14"/>'
                for i in range(5) for j in range(4))
    o = "".join(f'<rect x="{230+190*i}" y="222" width="12" height="12"/>' for i in range(5))
    u = '<line x1="230" y1="760" x2="1170" y2="760"/>' + "".join(
        f'<line x1="{230+200*i}" y1="760" x2="{230+200*i}" y2="600"/>' for i in range(1, 5))
    p = '<line x1="215" y1="700" x2="500" y2="700"/><line x1="500" y1="700" x2="500" y2="300"/>'
    return SVG.format(g=g, c=c, b=b, f=f, d=d, w=w, l=l, o=o, u=u, p=p)


async def main():
    pathlib.Path("test/fixtures").mkdir(parents=True, exist_ok=True)
    pathlib.Path("test/fixtures/plan.html").write_text(build(), encoding="utf-8")
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        pg = await b.new_page()
        await pg.goto("file:///workspace/bim-studio/test/fixtures/plan.html")
        await pg.pdf(path="test/fixtures/building-plan.pdf", width="420mm", height="297mm",
                     print_background=True, prefer_css_page_size=True)
        await b.close()
    print("pdf bytes:", pathlib.Path("test/fixtures/building-plan.pdf").stat().st_size)

asyncio.run(main())
