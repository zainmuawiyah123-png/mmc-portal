import asyncio, json, sys, os
from playwright.async_api import async_playwright

URL = "http://127.0.0.1:8901/MMC-BIM-Studio.html"

async def main():
    errs, warns, logs, pageerrs = [], [], [], []
    async with async_playwright() as p:
        b = await p.chromium.launch(args=["--no-sandbox"])
        pg = await b.new_page(viewport={"width": 1440, "height": 1200})
        pg.on("console", lambda m: (logs.append(f"{m.type}: {m.text}")))
        pg.on("pageerror", lambda e: pageerrs.append(str(e)))
        await pg.goto(URL, wait_until="load", timeout=60000)
        await pg.wait_for_timeout(2500)
        info = await pg.evaluate("""() => ({
            mmcAi: !!window.MmcAi, mmcBim: !!window.MmcBim, mmcPdf: !!window.MmcPdf,
            pdfjs: !!window.pdfjsLib, pdfjsVer: window.pdfjsLib ? window.pdfjsLib.version : null,
            studio: !!window.__studio,
            aiRules: window.MmcAi ? Object.keys(window.MmcAi.RULES||{}).length : 0,
            bimSpec: window.MmcBim ? Object.keys(window.MmcBim.SPEC||{}).length : 0,
            aiFns: window.MmcAi ? Object.keys(window.MmcAi) : [],
            bimFns: window.MmcBim ? Object.keys(window.MmcBim) : [],
            pdfFns: window.MmcPdf ? Object.keys(window.MmcPdf) : [],
            bodyAlert: !!document.querySelector('.alert.err'),
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            stepReadHidden: document.getElementById('stepRead').classList.contains('hidden'),
            btnReadDisabled: document.getElementById('btnRead').disabled,
        })""")
        await pg.screenshot(path="test/00_load.png", full_page=True)
        await b.close()
    print(json.dumps({"info": info, "pageerrors": pageerrs,
                      "console": logs[:80]}, ensure_ascii=False, indent=1))

asyncio.run(main())
