# MMC AI Drawing Reader — Integration Checkpoint

Updated: 2026-11-21

## Protected baselines

- Live Render staging service: `mmc-ai-staging`
- Live URL: https://mmc-ai-staging.onrender.com/mmc-ai/index.html
- Render service ID: `srv-dbqmo2m7bikc73aij5e0`
- Render workspace ID: `tea-daslaiou01pc73cfa99g`
- Current Render deployment: `dep-dc0bln4s728c738eknf0`
- Current live commit: `d98d0ab99366114fd5a1c66569b0a3f9309a5c32`
- Current live source branch: `feature/mmc-ai-boq-import-foundation`
- Current UI file: `webpages/technical-proposal-kit_v5/mmc-ai/index.html`
- Current UI blob SHA: `47bc6eda19ad0c09d108cded1c5591c43bdde177`

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
