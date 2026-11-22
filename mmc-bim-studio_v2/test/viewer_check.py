import asyncio, json, pathlib
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
        await pg.wait_for_timeout(700)
        await pg.set_input_files("#fileInput", "test/fixtures/building-rev-a.dxf")
        await pg.wait_for_timeout(400)
        await pg.click("#btnRead")
        await pg.wait_for_function("()=>window.__studio.S.rows.length>0", timeout=30000)
        await pg.click("#btnRules")
        await pg.wait_for_timeout(800)
        await pg.click("#btnGen")
        await pg.wait_for_timeout(2500)

        viewer = await pg.evaluate("""()=>{
          const w=document.getElementById('viewerWrap');
          const mv=document.querySelector('model-viewer');
          const cv=document.querySelector('#viewerWrap canvas');
          const out={wrapHidden:w.classList.contains('hidden'), hasModelViewer:!!mv,
                     hasCanvas:!!cv, mvSrc: mv? (mv.getAttribute('src')||'').slice(0,60):null,
                     mvLoaded: mv? mv.loaded : null, mvError: mv? (mv.getAttribute('error')||null):null};
          if(cv){ const g=cv.getContext('webgl2')||cv.getContext('webgl');
                  out.canvasSize=[cv.width,cv.height]; out.webgl=!!g; }
          return out;
        }""")
        # summary text
        summary = await pg.evaluate("()=>document.getElementById('bimSummary').innerText")
        # BOQ link buttons
        links = await pg.evaluate("""()=>{
          const btns=[...document.querySelectorAll('[data-show-in-model], .show-in-model, button')]
            .filter(b=>/model|نموذج/i.test(b.textContent));
          return {count:btns.length, sample:btns.slice(0,3).map(b=>b.textContent.trim().slice(0,40))};
        }""")
        await pg.screenshot(path="test/30_viewer.png", full_page=False)
        await b.close()
    print(json.dumps({"viewer": viewer, "summary": summary[:1500], "boqLinks": links,
                      "errors": errs}, ensure_ascii=False, indent=1))

asyncio.run(main())
