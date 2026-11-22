import asyncio, json, base64, pathlib
from playwright.async_api import async_playwright

URL = "http://127.0.0.1:8901/MMC-BIM-Studio.html"
FX = pathlib.Path("test/fixtures/building-rev-a.dxf")

async def main():
    logs, pageerrs = [], []
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        pg = await b.new_page(viewport={"width": 1440, "height": 1400})
        pg.on("console", lambda m: logs.append(f"{m.type}: {m.text[:300]}"))
        pg.on("pageerror", lambda e: pageerrs.append(str(e)))
        await pg.goto(URL, wait_until="load")
        await pg.wait_for_timeout(1200)

        # --- upload via the real file input ---
        await pg.set_input_files("#fileInput", str(FX))
        await pg.wait_for_timeout(900)
        vis = await pg.evaluate("()=>({read: !document.getElementById('stepRead').classList.contains('hidden'), name: document.getElementById('fileName').textContent})")

        # --- read ---
        await pg.click("#btnRead")
        await pg.wait_for_function("()=>window.__studio.S.rows.length>0", timeout=30000)
        await pg.wait_for_timeout(700)
        after = await pg.evaluate("""()=>{
          const S=window.__studio.S;
          return {rows:S.rows.length, layers:Object.keys(S.layerMap).length,
            extent:S.extent, unitSel:document.getElementById('unitSel').value,
            units:S.units, report:document.getElementById('readReport').innerText.slice(0,900),
            cats:[...new Set(S.rows.map(r=>r.disciplineCategory))].sort(),
            disc:[...new Set(S.rows.map(r=>r.discipline))].sort(),
            unsupported:S.unsupported};
        }""")
        await pg.screenshot(path="test/10_read.png", full_page=False)

        # --- quantities ---
        await pg.fill("#p_wallHeightM", "3.0")
        await pg.fill("#p_wallThicknessM", "0.20")
        await pg.fill("#p_columnHeightM", "3.0")
        await pg.fill("#p_slabThicknessM", "0.20")
        await pg.fill("#p_footingDepthM", "0.60")
        await pg.fill("#p_beamWidthM", "0.30")
        await pg.fill("#p_beamDepthM", "0.60")
        await pg.fill("#p_ductWidthM", "0.60")
        await pg.fill("#p_ductHeightM", "0.30")
        await pg.fill("#p_pipeSizeM", "0.05")
        await pg.click("#btnRules")
        await pg.wait_for_timeout(1200)
        qty = await pg.evaluate("""()=>{
          const S=window.__studio.S; if(!S.rules) return {err:'no rules'};
          return {summary:S.rules.summary, results:S.rules.results.map(r=>({
            cat:r.category, disc:r.discipline, status:r.status,
            proposed:(r.proposed||[]).map(q=>q.label.ar+'='+q.value+' '+q.unit),
            reason:r.reason||null, formula:r.formula||null}))};
        }""")
        await pg.screenshot(path="test/11_qty.png", full_page=False)

        # --- BIM ---
        await pg.click("#btnGen")
        await pg.wait_for_timeout(2000)
        bim = await pg.evaluate("""()=>{
          const S=window.__studio.S;
          if(!S.model) return {err:'no model', summary:document.getElementById('bimSummary').innerText.slice(0,600)};
          return {count:S.model.elementCount, byCat:S.model.byCategory.map(c=>c.category+':'+c.count),
                  skipped:S.model.skipped, bounds:S.model.bounds,
                  params:S.model.parameters, viewer:!document.getElementById('viewerWrap').classList.contains('hidden'),
                  html:document.getElementById('bimSummary').innerText.slice(0,1200)};
        }""")
        await pg.screenshot(path="test/12_bim.png", full_page=False)

        # --- exports ---
        exports = {}
        for btn, key in [("#dlIfc","ifc"),("#dlGlb","glb"),("#dlJson","json"),("#dlCsv","csv")]:
            try:
                async with pg.expect_download(timeout=15000) as dl:
                    await pg.click(btn)
                d = await dl.value
                pathlib.Path(f"test/out.{key}").unlink(missing_ok=True)
                await d.save_as(f"test/out.{key}")
                exports[key] = {"name": d.suggested_filename,
                                "size": pathlib.Path(f"test/out.{key}").stat().st_size}
            except Exception as e:
                exports[key] = {"error": str(e)[:200]}

        await b.close()
    print(json.dumps({"upload": vis, "read": after, "qty": qty, "bim": bim,
                      "exports": exports, "pageerrors": pageerrs,
                      "console": [l for l in logs if not l.startswith("log:")][:40]},
                     ensure_ascii=False, indent=1))

asyncio.run(main())
