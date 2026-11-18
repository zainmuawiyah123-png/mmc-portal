# mmc-ai-v13-fixed — v2 (Standalone Demo + neubuild.ai-style images)

Complete reconstruction with all bug fixes, standalone demo mode (now with
BOQ CSV import), and 12 curated neubuild.ai-style images embedded.

## What's new in v2

| Area | Change |
|------|--------|
| **Bug fixes** | All 6 original bugs fixed (BACKFILL, HYDRANT, مجاري, طريق, جدران, PUMP, plus the `disciplines.length` UI bug) |
| **Standalone mode** | `mmc-ai-bundle.js` + `mmc-ai-demo-backend.js` — entire v13 backend replaced with in-browser JS |
| **BOQ import** | NEW `/api/mmc-ai/projects/:id/boq-imports` endpoint — parses CSV (comma or semicolon, Arabic/English headers), stores items in localStorage |
| **Images** | 12 neubuild.ai-style images auto-injected into page placeholders via the bundle (no manual HTML edits) |
| **Cleaner errors** | All demo-mode errors now bilingual (Arabic + English) |

## Files in this bundle

```
mmc-ai-v13-fixed/
├── serve_preview.py                                   ← local server (Python 3, no deps)
├── README-FIXES.md                                    ← this file
├── CHANGELOG-FIXES.md                                 ← detailed Arabic changelog
├── server/
│   └── src/
│       ├── lib/mmc-ai/
│       │   ├── discipline-layer-classifier.js         ← BUG-FIXED
│       │   ├── discipline-measurement-kernels.js
│       │   ├── discipline-quantity-rules.js
│       │   ├── drawing-element-normalizer.js
│       │   ├── dxf-takeoff.js
│       │   └── demo-project.js
│       └── routes/mmc-ai-takeoff.js
└── webpages/technical-proposal-kit_v5/mmc-ai/
    ├── index.html                                     ← (use your existing copy — see below)
    ├── mmc-ai-bundle.js                               ← auto-injects 12 images
    ├── mmc-ai-demo-backend.js                         ← includes boq-imports
    └── assets/                                        ← 12 images (2 MB total)
        ├── hero-construction-site-1.jpg
        ├── hero-construction-site-2.jpg
        ├── hero-construction-site-3.jpg
        ├── worker-ar-tech-1.jpg
        ├── worker-ar-tech-2.jpg
        ├── worker-ar-tech-3.jpg
        ├── bim-model-screen-1.jpg
        ├── bim-model-screen-2.jpg
        ├── bim-model-screen-3.jpg
        ├── dashboard-gantt-1.png
        ├── dashboard-gantt-2.png
        └── dashboard-gantt-3.png
```

## Important note about index.html

This bundle does **NOT** include `index.html`. You must use your existing
copy from the previous download. To make it work with this v2 bundle, your
`index.html` needs these two changes (already applied in the previous
version you have):

1. **Public-preview gate disabled** (line ~1237):
   ```js
   const publicPreview = false; // Standalone demo mode
   ```

2. **Two script tags in `<head>`**:
   ```html
   <script src="/mmc-ai-bundle.js"></script>
   <script src="/mmc-ai-demo-backend.js"></script>
   ```

If you already have the previous mmc-ai-v13-fixed version working, your
index.html already has both edits — just drop the new `mmc-ai-bundle.js`,
`mmc-ai-demo-backend.js`, and `assets/` folder over your existing ones.

## How to run

```bash
# 1. Extract this zip over your existing mmc-ai-v13-fixed folder
#    (overwriting mmc-ai-bundle.js, mmc-ai-demo-backend.js, adding assets/)

# 2. Start the server
cd mmc-ai-v13-fixed
python serve_preview.py
# (or: py serve_preview.py on Windows if `python` doesn't work)

# 3. Open in browser
# http://localhost:8807/mmc-ai/workspace
```

You'll see a green banner: "وضع تجريبي مستقل (Standalone Demo v2)".

## What works in demo mode v2

| Feature | Status | Notes |
|---------|--------|-------|
| Project create / list / select | ✅ | localStorage |
| Document upload (.dxf) | ✅ | In-memory content |
| DXF takeoff (LINE / LWPOLYLINE / CIRCLE / ARC / INSERT) | ✅ | Full engine |
| Discipline classification | ✅ | Full engine, 9 disciplines |
| Quantity rules (25 rules across 8 disciplines) | ✅ | Full engine |
| Run review (approve / reject) | ✅ | |
| **BOQ CSV import** (NEW) | ✅ | Arabic/English headers, semicolon or comma |
| Manual BOQ item add | ✅ | |
| Project summary with BOQ totals | ✅ | |
| 12 neubuild.ai-style images | ✅ | Auto-injected via bundle |
| PDF takeoff | ❌ | Needs `pdftotext` (server-side) |
| BIM / IFC / GLB | ❌ | Needs file storage |
| User layer management | ❌ | DEMO_LIMIT response |
| AI assistant | ❌ | DEMO_LIMIT response |

## Bug fixes applied

| # | Bug | Severity | Status |
|---|-----|----------|--------|
| 1 | `disciplines.length` ReferenceError in UI | Critical | ✅ Fixed |
| 2 | BACKFILL / EARTH-FILL excluded as annotation | Critical | ✅ Fixed |
| 3 | Arabic "ري" substring false matches (طريق, مجاري, خريطة) | Critical | ✅ Fixed |
| 4 | HYDRANT-MAIN → unclassified (missing HYDR keyword) | High | ✅ Fixed |
| 5 | GEN-PUMP → unclassified (missing English PUMP) | High | ✅ Fixed |
| 6 | جدران (plural) → unclassified | Medium | ✅ Fixed |

## Verified

7/7 v2 end-to-end tests pass:

1. Create project → 201 ✓
2. BOQ import with null projectId → 400 NO_PROJECT (clean error) ✓
3. BOQ import valid CSV → 201 imported=3 ✓
4. List BOQ → 200 3 items ✓
5. Project summary includes boqItems=3, cost=39925 ✓
6. Manual BOQ add → 201 amount=11520 ✓
7. DXF takeoff still works → 201 1 item ✓

## Reset demo data

Data lives in `localStorage` under key `mmc-ai-demo-v2`. To wipe everything:

```js
// in browser console (F12)
localStorage.removeItem('mmc-ai-demo-v2'); location.reload();
```

## Deploy to GitHub

This bundle is git-friendly. To publish as a release:

1. Create a new GitHub repo (or use an existing one)
2. Push the entire `mmc-ai-v13-fixed/` folder
3. Tag a release — users can download the zip directly

Or upload `mmc-ai-v13-fixed.zip` as a release asset.

See `CHANGELOG-FIXES.md` for the full per-fix trace in Arabic.
