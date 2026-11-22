import asyncio, json
from playwright.async_api import async_playwright

URL = "http://127.0.0.1:8901/MMC-BIM-Studio.html"

async def main():
    errs = []
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        pg = await b.new_page(viewport={"width": 1440, "height": 1200})
        pg.on("pageerror", lambda e: errs.append("pageerror: " + str(e)))
        pg.on("console", lambda m: errs.append("console: " + m.text) if m.type == "error" else None)
        await pg.goto(URL, wait_until="load")
        await pg.wait_for_timeout(800)
        await pg.set_input_files("#fileInput", "test/fixtures/building-plan.pdf")
        await pg.wait_for_timeout(1500)
        await pg.fill("#pdfScale", "100")
        await pg.click("#btnRead")
        await pg.wait_for_function("()=>window.__studio.S.rows.length>0", timeout=60000)
        await pg.wait_for_timeout(1200)
        read = await pg.evaluate("""()=>{
          const S=window.__studio.S;
          return {kind:S.kind, rows:S.rows.length, page:S.page,
                  pages:S.pdf?S.pdf.pages.length:0,
                  scale:S.pdf?S.pdf.pages[0].scale:null,
                  warnings:S.pdf?S.pdf.warnings:[],
                  cats:[...new Set(S.rows.map(r=>r.disciplineCategory))].sort(),
                  layers:Object.keys(S.layerMap).length};
        }""")
        # confirm scale then run rules + BIM
        await pg.check("#scaleOk")
        await pg.wait_for_timeout(300)
        await pg.click("#btnRules")
        await pg.wait_for_timeout(1500)
        qty = await pg.evaluate("""()=>{
          const S=window.__studio.S; if(!S.rules) return {err:'none'};
          return S.rules.results.map(r=>({c:r.category,s:r.status,
            v:(r.proposed||[]).map(q=>q.label.ar+'='+q.value+' '+q.unit).join('; '),
            why:r.reason||null}));
        }""")
        await pg.click("#btnGen")
        await pg.wait_for_timeout(2500)
        bim = await pg.evaluate("""()=>{
          const S=window.__studio.S;
          return {count:S.model?S.model.elementCount:0,
                  byCat:S.model?S.model.byCategory.map(c=>c.category+':'+c.count):[],
                  skipped:S.model?S.model.skipped.map(s=>s.category+'x'+s.count):[]};
        }""")
        await pg.screenshot(path="test/40_pdf.png", full_page=True)
        await b.close()
    print(json.dumps({"read": read, "qty": qty, "bim": bim, "errors": errs},
                     ensure_ascii=False, indent=1))

asyncio.run(main())
