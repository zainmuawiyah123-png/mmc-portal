import asyncio, json, pathlib
from playwright.async_api import async_playwright

URL = "http://127.0.0.1:8901/MMC-BIM-Studio.html"
DXF = pathlib.Path("test/fixtures/building-rev-a.dxf").read_text(encoding="utf-8")

async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        pg = await b.new_page()
        await pg.goto(URL, wait_until="load")
        await pg.wait_for_timeout(800)
        out = await pg.evaluate("""(text) => {
          const t = window.MmcAi.takeoffDxf(text, {});
          const walls = t.rows.filter(r => r.disciplineCategory === 'walls');
          const byLayer = {};
          for (const r of t.rows) {
            const c = window.MmcAi.classifyLayer(r.layer, {});
            (byLayer[r.layer] = byLayer[r.layer] || {n:0, cat:c.category, disc:c.discipline, len:0});
            byLayer[r.layer].n++; byLayer[r.layer].len += (r.quantity||0);
          }
          return {
            total: t.rows.length,
            byLayer,
            wallCount: walls.length,
            wallSum: walls.reduce((s,r)=>s+(r.quantity||0),0),
            walls: walls.map(r => ({e:r.entity, len:+(r.quantity||0).toFixed(3),
                                    closed:!!r.closed, area:r.area_m2?+r.area_m2.toFixed(2):null,
                                    layer:r.layer})),
          };
        }""", DXF)
        await b.close()
    print(json.dumps(out, ensure_ascii=False, indent=1))

asyncio.run(main())
