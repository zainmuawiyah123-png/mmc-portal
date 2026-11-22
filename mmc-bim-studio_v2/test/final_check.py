"""Final acceptance run: every path, every export, both revisions, mobile."""
import asyncio, json, pathlib
from playwright.async_api import async_playwright

URL = "http://127.0.0.1:8901/MMC-BIM-Studio.html"
OUT = pathlib.Path("test/final"); OUT.mkdir(parents=True, exist_ok=True)


async def run_dxf(pg, fx, tag):
    await pg.goto(URL, wait_until="load"); await pg.wait_for_timeout(700)
    await pg.set_input_files("#fileInput", fx); await pg.wait_for_timeout(400)
    await pg.click("#btnRead")
    await pg.wait_for_function("()=>window.__studio.S.rows.length>0", timeout=40000)
    await pg.click("#btnRules"); await pg.wait_for_timeout(1000)
    await pg.click("#btnGen"); await pg.wait_for_timeout(2200)
    res = await pg.evaluate("""()=>{
      const S=window.__studio.S;
      const byDisc={};
      for(const r of (S.rules?S.rules.results:[])){
        const d=byDisc[r.discipline]||(byDisc[r.discipline]={proposed:0,incomplete:0});
        r.status==='proposed'?d.proposed++:d.incomplete++;
      }
      return {rows:S.rows.length, elements:S.model?S.model.elementCount:0,
              byDisc, merged:S.model?S.model.wallsMerged:0,
              openings:S.model?S.model.openings:null,
              skipped:S.model?S.model.skipped.map(s=>s.category+'x'+s.count):[],
              overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth};
    }""")
    files = {}
    for btn, key in [("#dlIfc", "ifc"), ("#dlGlb", "glb"), ("#dlJson", "json"), ("#dlCsv", "csv")]:
        async with pg.expect_download(timeout=20000) as dl:
            await pg.click(btn)
        d = await dl.value
        p = OUT / f"{tag}.{key}"
        await d.save_as(str(p))
        files[key] = p.stat().st_size
    await pg.screenshot(path=str(OUT / f"{tag}.png"), full_page=True)
    return res, files


async def main():
    errs = []
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        pg = await b.new_page(viewport={"width": 1440, "height": 1200})
        pg.on("pageerror", lambda e: errs.append("pageerror: " + str(e)))
        pg.on("console", lambda m: errs.append("console: " + m.text) if m.type == "error" else None)

        a, fa = await run_dxf(pg, "test/fixtures/building-rev-a.dxf", "rev-a")
        bb, fb = await run_dxf(pg, "test/fixtures/building-rev-b.dxf", "rev-b")

        # PDF path with manual colour mapping
        await pg.goto(URL, wait_until="load"); await pg.wait_for_timeout(700)
        await pg.set_input_files("#fileInput", "test/fixtures/building-plan.pdf")
        await pg.wait_for_timeout(1500)
        await pg.fill("#pdfScale", "100")
        await pg.click("#btnRead")
        await pg.wait_for_function("()=>window.__studio.S.rows.length>0", timeout=60000)
        await pg.wait_for_timeout(500)
        pdf = await pg.evaluate("""()=>{const S=window.__studio.S;return{
          rows:S.rows.length, pages:S.pdf.pages.length, scale:S.pdf.pages[0].scale.used,
          colours:Object.keys(S.layerMap).length,
          layers:[...new Set(S.rows.map(r=>r.layer))]};}""")

        # mobile
        await pg.set_viewport_size({"width": 390, "height": 900})
        await pg.wait_for_timeout(500)
        mob = await pg.evaluate("()=>({overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth})")
        await pg.screenshot(path=str(OUT / "mobile.png"), full_page=True)
        await b.close()
    print(json.dumps({"revA": a, "filesA": fa, "revB": bb, "filesB": fb,
                      "pdf": pdf, "mobile": mob, "errors": errs},
                     ensure_ascii=False, indent=1))

asyncio.run(main())
