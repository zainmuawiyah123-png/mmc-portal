# Independent Consulting Portal — Phase 1 Architecture

Status: architecture baseline only. No production schema, account, billing, evaluator, procurement, contractor, or Render changes are made by this document.

## Approved commercial rules
- A free basic profile for a consulting firm.
- Professional firm subscription: USD 20 per month.
- Do not introduce a USD 25 price, annual price, free professional trial, or consultant promotional entitlement without a separate approval.
- A requesting entity pays no platform subscription to publish a consultancy service request or review proposals.
- Any automatic monthly renewal must require explicit opt-in and a valid payment method, with advance notice and cancellation controls. Do not infer consent from registration.

## Four independent portals
1. Procurement portal: buyer's internal procurement lifecycle; core functions remain permanently free.
2. Contractor portal: existing contractor tender and bid workflows and their existing prices remain unchanged.
3. Consulting-firm portal: a separate professional-services marketplace, not the evaluator workspace.
4. Administration portal: platform account and subscription operations only; no routine access to confidential bids or competitor proposals.

## Critical existing-code boundary
The existing `webpages/technical-proposal-kit_v5/consultant/index.html` is the existing tender committee evaluator workspace. It calls `/api/committee/my-assignments` and `/api/committee/tenders/:id/work`. It must remain unchanged and must not be repurposed.

The committee evaluator is an assignment (`tender_evaluators`) attached to a tender. It is not the same thing as a consulting-firm marketplace account. Preserve evaluator routes, anonymisation, technical-only document visibility, and score confidentiality.

The existing `/api/requests` flow is the buyer's project/request-to-procurement workflow, not the consultancy marketplace. The existing `/api/opportunities` feed is contractor-facing external tender discovery. Neither is to be reused as the consultancy market.

## Proposed independent URL and API namespaces
- UI: `/consulting/` (new pages only; never modify `/consultant/`).
- API: `/api/consulting/*` (new router, new authorization middleware, new tests).
- Do not expose new consultancy records through `/api/org`, `/api/requests`, `/api/opportunities`, `/api/committee`, or project-finance routes.

## Proposed independent data model (additive only)
- `consulting_firms`: legal firm identity, country, normalized registration number, identity key, verification status, profile fields, created/updated timestamps.
- `consulting_firm_members`: firm/user membership and firm-specific roles. Enforce one legal firm identity per country + normalized registration number. Do not repurpose buyer `organizations` or `org_members`.
- `consulting_requester_entities` and `consulting_requester_members`: independent legal identity and membership for entities requesting consultancy services; do not reuse buyer procurement organizations.
- `consulting_service_requests`: requesting entity, scope, discipline, country/location, procurement timetable, visibility and lifecycle status.
- `consulting_proposals`: firm-scoped technical and financial proposal records; one proposal per firm per request. Competitor proposal data is returned only to the requesting entity, never to another firm.
- `consulting_contracts`: selected firm, accepted proposal, contract references, award/acceptance state, delivery tracking.
- `consulting_documents`: private document metadata linked to request/proposal/contract, stored through the existing storage abstraction. Request briefs are visible to verified firms while the request is open; proposal files are visible only to their submitting firm and the requesting entity; contract files are visible only to the two contract parties.
- Add event/audit records for verification, proposal submission/revision, selection and contract lifecycle.
- Store uploaded documents through the existing storage abstraction, with separate ownership keys and access checks; never serve private proposal documents as static files.

## Identity and verification separation
- The existing registration schema supports `consultant`, but that role is also used by committee evaluators. A user becomes a consulting-market participant only by explicitly creating a separate `consulting_firm_members` record; an evaluator assignment alone does not grant firm membership or consultant-market billing. Do not silently reinterpret or migrate existing consultant users.
- Introduce a separate consulting-firm membership/eligibility check and onboarding flow. An existing evaluator does not become a firm member merely because their user role is `consultant`.
- Collect country, legal registration number, official contact details, and evidence documents in the consulting-firm onboarding process. Normalize country + registration number for duplicate detection.
- Verification must be independent of buyer `org_verifications`; do not attach consultant firms to buyer organizations.
- Do not assume email/SMS OTP is available: the current mail queue depends on SMTP configuration, and no verified OTP flow was found. Build verification as an explicit, testable process with delivery readiness checks before enabling OTP.

## Subscription isolation
- The current `billing.js` and `account.js` historically mapped evaluator-role users to contractor plans. They now check explicit consulting-firm membership before isolating a member into the consulting audience, preserving evaluator-only accounts and contractor prices while preventing a registered firm member from falling through to contractor billing.
- The current invoice flow supports currency conversion using `org.js` and accepts several invoice currencies. The approved platform subscription policy is USD-only. A separate consulting subscription implementation must store and return USD amounts only and must not change project invoice currencies.
- Do not add a consultant plan to the shared contractor audience or use the generic contractor subscription path until isolation and regression tests prove no cross-audience effects.
- Suggested isolated plan identifier: `consultant_pro`, monthly amount `20`, currency `USD`; implement only in a separate consultant billing path or a carefully audience-scoped billing design with explicit regression coverage.

## Implementation sequence and release gates
1. Preserve the evaluator page and inspect all references to `/consultant/`, `role === 'consultant'`, `audienceFor`, plan lookup, invoice creation/approval, and static serving.
2. Add the new UI namespace and a server-side gate that requires a verified consulting-firm membership. Do not rely on client-side hiding.
3. Add additive, idempotent migrations for consulting-only tables and indexes. No DROP, rename, destructive backfill, or production migration.
4. Implement `/api/consulting/*` endpoints with independent firm/requester authorization, document upload/download/delete, storage checksums, file type/size limits, and selected-party access.
5. Implement independent request/proposal/selection/contract lifecycle, audited progress updates, and strict competitor confidentiality. Requesters can review every proposal for their own request; competing firms cannot access one another's proposals or attachments.
6. Add isolated USD-only $20/month billing and explicit renewal consent; no trial and no annual price.
7. Add tests for route isolation, tenant isolation, firm membership, duplicate legal identity, proposal confidentiality, document access, billing amount/currency, contractor billing unchanged, evaluator routes unchanged, procurement routes unchanged, and no subscription currency conversion.
8. Run all existing test suites plus new tests on the development branch. Inspect the diff and workflow results.
9. Keep the PR draft. No merge, production database migration, or Render deployment without explicit approval.

## Current development state
- Development branch: `feature/consultant-portal-independent-phase1`
- Base: `feature/buyer-free-core-phase1`
- The branch is separate from `main`; no production deployment is authorized.
- Implemented on development branch: protected consultant and requester workspaces; isolated firm/requester identities and verification; independent service requests; confidential proposals; award and contract records; contract progress/status updates; additive consulting document metadata; secure file upload/download/delete endpoints; UI attachment controls; request/selected-party document visibility; and billing audience isolation for verified consulting-firm members while preserving existing evaluator classification.
- The last completed full CI run before the document workflow additions succeeded (`npm run test:all`; earlier counts: API 89/89, consulting 8/8, finance UI 36/36, opportunity tests 22/22, scheduler 1/1, UK sync 8/8). New document upload/download, request-owner proposal review, awarded-firm document visibility, and document UI tests have since been added. Latest GitHub Actions run for current implementation: run `42785447037` completed successfully; `npm run test:all` passed. The independent consulting suite passed 9/9, including document upload/download, requester review of all own proposals, competitor attachment isolation, selected-firm access after award, upload ownership/closing cutoff, contract progress/status and page-script syntax. The S3 integration test was skipped because `S3_TEST_ENDPOINT` is not configured. Vercel preview status checks currently fail with a build-rate-limit response; these are not Render production deployments. No production merge or deployment was made.
- Professional billing remains intentionally unavailable; $20 USD/month is displayed as the approved price only. No automatic renewal or charge is active.
- No production migration, merge, or Render deployment has occurred.