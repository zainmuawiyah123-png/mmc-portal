# MMC AI Drawing Reader — Integration Checkpoint

Updated: 2026-11-21

## Protected baselines

- Live Render staging service: `mmc-ai-staging`
- Live URL: https://mmc-ai-staging.onrender.com/mmc-ai/index.html
- Render service ID: `srv-dbqmo2m7bikc73aij5e0`
- Render workspace ID: `tea-daslaiou01pc73cfa99g`
- Current Render deployment: `dep-dc0qk1u1egvs738otgd0` (status `live`, verified 2026-11-21 14:26 UTC)
- Current live commit: `7f49e42df4223d445debce929185d93ed0e7bc3a`
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

## 2026-11-21 — Authenticated PDF vector geometry action added

- Added `POST /api/mmc-ai/projects/:projectId/documents/:documentId/extract/vector-geometry` to the existing authenticated document route.
- The route verifies project membership, stored file existence, byte length and SHA-256, then invokes the already-present Poppler SVG vector extractor for a requested PDF page (default page 1; page numbers 1–100).
- Results are persisted in `ai_document_analyses` as `pdf_vector_geometry` and recorded in `ai_audit_log`.
- Added a visible `Extract Vector Geometry (Page 1)` action to the existing document list UI. It displays vector path count, closed shape count, unsupported path count, drawing-space lengths/areas, viewBox and calibration status.
- The UI explicitly states that drawing-space values are not metres or square metres and does not claim element classification, BOQ quantities or 3D output.
- Added a regression assertion for the UI action and its measurement limitation.
- Commits: `5c55c27ac2fd976ed2a54a02b5786aa53b8eddd1` (route), `cbdfaf3656f7c1449b1c1a4d9b130fe2c4d9aa57` (UI), `00b953b8fd27a9715344357543f544f70633c250` (test).
- Render deploy: `dep-dc0peue7bikc73bgevq0`; Docker test gate reported 68 tests passed, 0 failed. At checkpoint time deploy status was `update_in_progress`; do not claim the new UI is live until Render reports `live`.
- This is a manually invoked, single-page vector extraction step. It is not automatic full-document drawing interpretation, scale-calibrated measurement, discipline classification, BOQ takeoff or 3D model generation.


## 2026-11-21 — Live project dashboard KPI binding

- Corrected the four legacy dashboard KPI cards that previously remained hard-coded as em dashes / “No live project data in this preview” even when a signed-in user had selected a project and loaded its documents.
- The project list now supplies the active-project count. The selected-project dashboard API now includes the count of distinct documents with saved analysis records, the count of saved PDF vector page analyses, and a compact summary of the latest vector analysis (page, path count, closed path count, calibration flag and status).
- The selected-project UI now binds BOQ item count and recorded engineering alerts (critical risks + open BIM issues) to the secured dashboard response. It labels vector extraction separately and explicitly says it is not verified quantity takeoff.
- Completing a vector geometry extraction refreshes the dashboard KPIs immediately.
- Existing project membership checks remain in place; no public data endpoint, project mutation, BOQ write or file-storage behavior was added by this change.
- Commits: `b9c2f0d97083ae49ee581c7264a6dfa444079e01` (dashboard API), `14a7a474212b99f23eabe674b34e8d3e52385187` (UI), `7f49e42df4223d445debce929185d93ed0e7bc3a` (regression test).
- Render deploy: `dep-dc0qk1u1egvs738otgd0`, status `live`; Docker build test gate reported 69 tests passed, 0 failed.
- Remaining: validate the live dashboard with the signed-in user's existing project session; then implement page-level correlation between vector geometry and native/OCR text evidence. Do not treat distinct analysed documents as quantities or infer scale from vector/page dimensions.


## 2026-11-21 — First-page PDF text/vector spatial evidence integration

- Extended the authenticated `POST /projects/:projectId/documents/:documentId/analyze/drawing-text` action. It now reads native PDF word bounding boxes for page 1, extracts page-1 vector paths from the same stored PDF, converts native text words to the existing normalized page coordinate space, and returns nearest vector-path candidates for text lines that resemble dimensions or engineering tags.
- Added `pdf-evidence-correlation.js` with aspect-ratio alignment guard (withholds matching when page/SVG aspect ratios differ by more than 2.5%), nearest-path candidate matching and explicit non-measurement limitations. Candidate associations are not element classifications and are not eligible for measurement.
- Saved page evidence, vector evidence, matching output and errors in the existing `pdf_drawing_text` analysis record; audit metadata includes native spatial word count and number of matched lines. No new DB table or BOQ write path was added.
- Updated the existing Read Drawing UI result to display native spatial dimensions/elements, page/vector summary, spatial correlation candidates and extraction errors. The current page design is retained.
- Added two correlation unit tests and a UI regression test; added the new test and syntax check to the Docker build gate.
- Commits: helper `117d676b427224abe612e9b0f242f8e22835f20e`; tests `4d76467eaab712920aab766b9119827195fffc5a`; API `3e6f06c3f60f85d13e5081ddafbab82336ce47ca`; UI `96f188d837f577c1bf5e796929549837592d023f`; regex correction `b132c2cbcdcb16d0fec7803608e482e4f6d17a80`; Docker gate `7e26a02736ddefd3323113f5e7c6db6f06a3ab88`; UI test correction `f95d0de13567f39568b80c0b7ded25b6a6083b36`.
- Render deploy `dep-dc0qpr6c6qcc73f6cj80` status `live`; Docker gate reported 72 tests passed, 0 failed.
- Validation pending with the actual user PDF session: invoke Read Drawing on the existing stored PDF and inspect the returned native text word count, vector geometry summary, aspect-ratio status, and spatial candidate list. If native text is absent or the coordinate spaces fail the alignment guard, no association is claimed. OCR-only spatial correlation, scale calibration, verified element classification, BOQ quantities and 2D-to-3D remain future work.


## 2026-11-21 — OCR-aware spatial matching and bounded drawing-reader action

- Corrected the drawing-text analysis sequence: PDF page/vector evidence is collected first, OCR runs when native text evidence is sparse or image content is present, and spatial correlation runs only after OCR has completed.
- Added OCR TSV word-box grouping and coordinate normalization for Poppler's `pdftoppm -scale-to 2600` render output. When native PDF text coordinates are insufficient, page-1 OCR word boxes can now supply spatial text lines for candidate matching. The source used is returned as `spatialCorrelationSource`.
- Added a real Poppler fixture integration test that extracts native text and SVG vectors from the same generated PDF page, then verifies candidate-only spatial matching and the non-measurement boundary. Added a unit test for OCR coordinate normalization.
- Added a 90-second client request timeout to the existing Read Drawing action; the action now resets its disabled/loading state and gives a clear timeout message rather than remaining indefinitely in “Reading drawing...”.
- Existing page design, document storage, BOQ records and manual takeoff paths were not changed.
- Commits: OCR normalization helper and route integration (see commits immediately preceding this checkpoint); OCR coordinate test `10eb0862be1d60daef41e70305ea1550ff6670cb`; UI timeout `8d954ff5272acb1fab4a07a108806dbb7c52d3c7`; UI test `8dbfb3831a51616f77482ae64a898497b9ef2741`; PDF end-to-end fixture test `df594841a01ecc1a88a97d41a5d70c2272014a01`.
- Validation status: Docker build gate includes syntax checks plus OCR, drawing-reader UI, PDF page-evidence, vector and correlation suites. Render deployment and its build/test result must be checked before this change is considered deployed. The synthetic fixture validates pipeline compatibility only; the user's existing PDF still requires authenticated live-session validation. No scale, engineering classification, BOQ quantities or 3D geometry are claimed.


## 2026-11-22 — Real drawing reference and first structural concrete quantity

### Protected deployment baseline
- Render service: `mmc-ai-staging`, URL `https://mmc-ai-staging.onrender.com`.
- Render remains on branch `mmc-bim-review-integration`, commit `cd9cf2b67b15ad3a774db93b691d09b3621cf851` (live at the last check).
- This work is isolated on `fix/drawing-analysis-pipeline`. No Render deployment, production update, or database mutation was performed.

### Actual drawing inspected
- Library document: `266790015V4C.pdf`, 7,638,948 bytes, 20 pages, PDF 1.4.
- SHA-256: `bdeb288844759b4d153e6d9a498ad5ed5231b358d0472124ea10889e285253ff`.
- Page 4: foundation layout and footing mark callouts F1–F6.
- Page 6: isolated-footing schedule with length, width and depth for F1–F6.
- The previous Python prototype in the Library already contained a manually prepared reference schedule/count set for this same drawing. It was used as a cross-check, not as a runtime input or production default.

### First quantity reference
- F1: 2 × 2.40 × 2.40 × 0.60 = 6.912 m³
- F2: 3 × 2.60 × 2.60 × 0.60 = 12.168 m³
- F3: 8 × 3.00 × 3.00 × 0.70 = 50.400 m³
- F4: 1 × 3.30 × 3.30 × 0.70 = 7.623 m³
- F5: 1 × 5.80 × 2.80 × 0.60 = 9.744 m³
- F6: 2 × 2.90 × 2.60 × 0.60 = 9.048 m³
- Total isolated-footing concrete: **95.895 m³**.
- Excludes blinding, pedestals/column necks, columns, grade beams, continuous footings, excavation, backfill, reinforcement and wastage. This is a reviewed reference quantity, not a claim that the live MMC AI app automatically extracted it.

### Code and regression work
- Added `pdf-quantity-candidates.js`: conservative dimension-to-vector scale candidates; a single nearby dimension/path match never calibrates a page. Scale remains unapplied pending explicit confirmation.
- Connected the per-page scale-evidence result to the authenticated PDF drawing-text analysis record and response.
- Updated the existing UI to display each page's scale-evidence output.
- Added `pdf-structural-quantity-engine.js`: calculates isolated footing concrete from normalized schedule rows and plan mark counts, with source pages and formula per item; missing or unmatched marks fail closed.
- Added the real-drawing golden reference fixture `server/tests/fixtures/mmc-real-266790015V4C-footing-reference.json` and regression tests. The fixture is a test oracle only; it is not loaded by runtime code.
- Added a branch-only GitHub Actions test workflow. Latest run `44997597476` completed successfully: 174 tests, 172 passed, 0 failed, 2 skipped.
- The earlier CI failures exposed a wrong expected scale value in the synthetic test and missing Poppler/Tesseract packages on the GitHub runner. Both were corrected before the successful run.

### Remaining critical work — do not declare automatic takeoff complete
1. Extract footing schedule rows F1–F6 from OCR/table-cell evidence on the actual PDF; do not hardcode these values in the runtime.
2. Extract and count plan marks from the actual foundation layout, including low-confidence/missed labels. If a mark count cannot be proven, return it as unresolved.
3. Connect those extracted, traceable candidates to `pdf-structural-quantity-engine.js` in the authenticated PDF takeoff route.
4. Persist a `needs_review` takeoff run with per-item formula, schedule page, plan page, source OCR/vector evidence and unresolved register.
5. Validate the actual stored PDF through the app's authenticated project workflow. Only then claim automatic takeoff. Do not deploy until the user separately approves a staging deployment.

