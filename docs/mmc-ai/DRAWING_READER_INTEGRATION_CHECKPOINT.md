# MMC AI Drawing Reader — Integration Checkpoint

Updated: 2026-11-21

## Protected baselines

- Live Render staging service: `mmc-ai-staging`
- Live URL: https://mmc-ai-staging.onrender.com/mmc-ai/index.html
- Render service ID: `srv-dbqmo2m7bikc73aij5e0`
- Render workspace ID: `tea-daslaiou01pc73cfa99g`
- Current Render deployment: `dep-dc0p44u1egvs738kgppg` (status `live`, verified 2026-11-21 12:45 UTC)
- Current live commit: `51a484c215fc6dd4520922d0f722d0be7fb40ecd`
- Current live source branch: `feature/mmc-ai-boq-import-foundation`
- Current UI file: `webpages/technical-proposal-kit_v5/mmc-ai/index.html`
- Current UI file: `webpages/technical-proposal-kit_v5/mmc-ai/index.html` (contains `Read Drawing (OCR + Evidence)` action)

## Drawing-engine source work — preserve, do not overwrite

- Source branch: `feature/mmc-ai-drawing-reader-demo`
- Important saved design contract: `docs/MMC_AI_UNIVERSAL_DRAWING_ENGINE.md`
- Implementation plan: `docs/mmc-ai/drawing-intelligence-engine-v1-implementation-plan.md`
- Latest specifically inspected pilot commit: `4cd63855bc3b59502d5f73cfd3c128984ed6acc6` — “Add pilot PDF structural takeoff” (2026-11-12).
- That source branch contains PDF text/OCR/vector evidence, DXF parsing, discipline measurement kernels, quantity records, BOQ compiler, 2D-to-3D candidates, tests and a modified MMC AI page.

## Important branch relationship

The drawing-reader source branch and the currently deployed branch are heavily diverged (compare reported 440 commits ahead and 220 behind). Do not merge the whole source branch or switch Render to it. Preserve the currently deployed MMC AI UI and selectively port/test backend capabilities.

## Verified current gap

The live branch's `server/src/routes/mmc-ai-documents.js` stores uploaded documents but does not run automatic drawing analysis. The drawing-reader source branch has a richer document route and supporting modules, but its automatic PDF result still explicitly withholds quantities and 3D output in cases without verified geometry. Its OCR/evidence collection must not be described as a completed universal takeoff engine.

## Latest staging deployment — important limitation

- Render service branch remains `feature/mmc-ai-boq-import-foundation`; auto-deploy is disabled, so deploys are triggered explicitly.
- Latest deployment `dep-dc0p44u1egvs738kgppg` is live; its Docker build completed successfully.
- Added OCR runtime (Tesseract Arabic + English and Poppler), authenticated PDF drawing-text endpoint, persistent analysis/audit rows, and a separate UI action.
- **This is not an engineering takeoff.** The endpoint currently extracts text/OCR clues, title-block candidates, dimension annotations and their OCR pixel boxes. It explicitly does not reconstruct drawing geometry, calibrate scale, calculate quantities or create a 3D model.
- Upload currently only stores the document and explicitly reports “Engineering analysis has not started yet.” Preflight only checks PDF integrity. The new “Read Drawing (OCR + Evidence)” action must be invoked separately on a signed-in project document; it is not automatically run on upload.
- The user has shown a preflight-only result for a 7.29 MB, 20-page PDF. That result confirms no engineering analysis has yet been run. Dashboard text “Project data appears after account sign-in” / “No live project data in this preview” also indicates the shown dashboard state is not presenting authenticated live project data.
- The user is dissatisfied because the requested automatic drawing analysis and quantity takeoff are still not delivered. Do not claim otherwise.

## Next implementation sequence

1. Compare the PDF document route and its exact dependencies against the live branch.
2. Port a read-only PDF page-evidence slice first: page inventory, text/OCR/vector evidence, stable page coordinates, scale/dimension candidates, unresolved/conflict register and audit persistence.
3. Preserve original document bytes, SHA-256, project scope, auth, audit log and existing manual BOQ data.
4. Add/run focused automated tests before a staging deployment.
5. Validate against the already uploaded `266790015V4C.pdf` only if it remains available in authorized project storage. Do not upload drawings to external services.
6. Only after evidence validation, proceed to scale calibration, geometry, discipline measurements, 2D-to-3D and BOQ handoff.

## Non-negotiable rules

- Do not change the existing Render UI design.
- Do not change production or production data.
- Do not delete or alter the existing MMC test project or its manual Excavation BOQ line.
- OCR text is not geometry; a dimension callout alone is not a measured quantity.
- No guessed scale, dimensions, heights, thicknesses, materials, routes or quantities.
- Every candidate result remains review-required until authorized engineering approval.
- Keep each implementation slice in a separate commit and deploy to staging only after tests pass.

## 2026-11-21 — PDF geometry foundation ported to staging branch

- Ported the read-only Poppler PDF page inventory and native-text bounding-box evidence module from `feature/mmc-ai-drawing-reader-demo`.
- Ported SVG/PDF vector path parsing and geometric path measurement modules, including the existing explicit two-point calibration utility.
- Ported the focused regression tests and synthetic two-page PDF fixture used by those tests.
- Added these tests to `server/package.json` test:mmc-ai and the Docker build test gate. The Render build must now execute page-evidence, vector-geometry and PDF-vector-extraction regression tests.
- Files added: `server/src/lib/mmc-ai/pdf-page-evidence.js`, `pdf-vector-geometry.js`, `pdf-pdf-vector-extract.js`, the three corresponding test files, and `server/tests/fixtures/mmc-ai-pdf-fixtures.js`.
- Important boundary: this commit only ports and gates the geometry foundation. It does NOT yet connect these modules to the authenticated document workflow or automatically analyze uploaded project drawings. No measured quantity, BIM element, 3D model, or takeoff result is claimed.
- Next: add a project-authorized analysis route that retrieves the stored PDF, verifies size and SHA-256, inventories pages and extracts vector paths, persists source-linked results and audit events, then expose that analysis in the existing MMC AI UI without changing its design. Keep expensive multi-page work bounded/backgrounded; do not block uploads or invent scale.
- Do not deploy or call the drawing-reader task complete until the integration route, UI result visibility, regression build, and a real stored drawing validation are all verified.
