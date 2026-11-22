import asyncio, json, pathlib
from playwright.async_api import async_playwright

URL = "http://127.0.0.1:8901/MMC-BIM-Studio.html"

async def run(pg, fx, label):
    await pg.goto(URL, wait_until="load")
    await pg.wait_for_timeout(700)
    await pg.set_input_files("#fileInput", fx)
    await pg.wait_for_timeout(500)
    await pg.click("#btnRead")
    await pg.wait_for_function("()=>window.__studio.S.rows.length>0", timeout=30000)
    await pg.click("#btnRules")
    await pg.wait_for_timeout(900)
    await pg.click("#btnGen")
    await pg.wait_for_timeout(1500)
    return await pg.evaluate("""()=>{
      const S=window.__studio.S;
      const byDisc={};
      for(const r of (S.rules?S.rules.results:[])){
        const d=byDisc[r.discipline]||(byDisc[r.discipline]={proposed:0,incomplete:0,cats:[]});
        if(r.status==='proposed'){d.proposed++;d.cats.push(r.category);} else d.incomplete++;
      }
      return {rows:S.rows.length, elements:S.model?S.model.elementCount:0,
              byDisc, skipped:S.model?S.model.skipped.map(s=>s.category+'x'+s.count):[],
              overflow: document.documentElement.scrollWidth-document.documentElement.clientWidth};
    }""")

async def main():
    errs=[]
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        pg = await b.new_page(viewport={"width":1440,"height":1200})
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append("console:"+m.text) if m.type=="error" else None)
        a = await run(pg, "test/fixtures/building-rev-a.dxf", "A")
        await pg.screenshot(path="test/20_rev_a.png", full_page=True)
        bb = await run(pg, "test/fixtures/building-rev-b.dxf", "B")
        await pg.screenshot(path="test/21_rev_b.png", full_page=True)
        # mobile
        await pg.set_viewport_size({"width":390,"height":900})
        await pg.wait_for_timeout(400)
        mob = await pg.evaluate("()=>({overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth})")
        await pg.screenshot(path="test/22_mobile.png", full_page=True)
        await b.close()
    print(json.dumps({"revA":a,"revB":bb,"mobile":mob,"errors":errs}, ensure_ascii=False, indent=1))

asyncio.run(main())
