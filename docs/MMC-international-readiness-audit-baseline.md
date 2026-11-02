# MMC — International Readiness Audit Baseline
Date: 2026-11-02
Branch reviewed: `feature/contractor-award-payment-cycle`
Reviewed deployment commit: `9760bbda7c0c433e0126c2ec50237f5450819400`
Production branch: `main` — not modified.

## 1. Existing capabilities confirmed in source
- Buyer-side project request workflow exists: requester/owner creates and submits; Projects receives, studies, and prepares technical documents; Procurement receives a ready request and publishes a linked tender.
- FIDIC metadata exists for Red, Yellow, Silver, Green and Other; editions currently include 1999, 2017 and Other. Project request records the selected book, edition and particular notes.
- Request document kinds include drawings, specifications, BOQ, conditions, particular conditions and internal documents. Only configured public document kinds are exposed to contractors after publication.
- Procurement tender, submission and evaluation APIs exist. Financial offers are intended to remain hidden until technical qualification.
- Project awards, purchase orders, contractor invoices, procurement review, optional owner confirmation, Finance approval, partial/final payments and audit events have a separate project-finance module. Subscription invoices remain separate.
- Country/currency configuration currently covers the seven GCC states. This is a regional starting point, not yet a global country framework.

## 2. Confirmed gaps / risks to address before commercial launch
1. **Technical evaluation quality:** contractor answer scoring currently derives an initial 0/100 from whether an answer is present. The procurement UI submits an empty manual score list. A real evaluator scoring interface, evidence/comments, moderation and audit trail are required; presence of an answer must not be treated as technical merit.
2. **Tender document lifecycle:** no complete addendum/clarification/version workflow was confirmed. Need immutable published snapshots, numbered addenda, acknowledgements, controlled deadlines and a full correspondence register.
3. **FIDIC scope:** current code stores the selected book/edition and particular notes; this does not constitute licensed FIDIC contract-document generation or clause-by-clause contract administration. Any distribution/use of copyrighted standard forms requires the appropriate licence.
4. **International configuration:** current country list is GCC-only; timezone handling uses fixed offsets. Global launch requires country packs, IANA timezones, currency precision, tax/withholding/retention rules, legal entity identifiers, local procurement rules and configurable date/number formats.
5. **Project execution lifecycle:** no complete works execution module was confirmed for programmes, progress, instructions, variations, claims, EOT, interim payment certificates, tests, taking-over, defects liability and final account.
6. **Finance completeness:** assess VAT/tax, retention, advance payments/recovery, deductions, certificates, credit notes, multi-currency exchange rules, bank reconciliation and controlled invoice void/correction.
7. **UI access:** the procurement page is guarded at the static route. The project-finance HTML is currently served by the general static middleware without a page-level authentication guard; its API requires authentication. Protect the page shell while retaining role-scoped access for contractors, owners, procurement and Finance.
8. **Branch reconciliation:** `main` is two commits ahead of the common base; the development branch is 95 commits ahead and has diverged. Both branches contain different versions of `server/src/routes/project-finance.js`; the development version is mounted and has a corresponding UI, while main's route file is not mounted in `server/src/index.js`. Do not merge the development branch wholesale without reconciling this divergence.
9. **CI freshness:** workflow run `41479081667` completed successfully on commit `764fb40891a6e0d291318e56fd9c4d773815755f`, not the currently deployed `9760bbd...`. That older run reports 77 API tests and 2 migration tests passing; the S3 test was skipped. It did not execute the current package's browser/UI tests. Re-run the full current suite against the current branch head.
10. **Dependency security:** the logged `npm ci` output reported 6 dependency vulnerabilities (1 moderate, 5 high). Review the full audit tree and update dependencies in a controlled, tested change; do not use force upgrades blindly.

## 3. Required delivery gates
- Requirements and role matrix signed off for Owner, Projects, Procurement, Evaluation Committee, Contractor, Finance and MMC Platform Admin.
- Additive migration tested against a protected copy of the real database; repeatability, backup and restore verified.
- API authorization tests for every role, tenant, tender, document and financial object.
- Full browser/E2E tests for the end-to-end lifecycle and negative permission cases.
- S3-compatible storage integration test actually executed (not skipped), malware/file validation and document access tests.
- Performance/load, accessibility, localization, disaster recovery and security review.
- Country-specific legal/compliance review before enabling a country pack.
- Production rollout only after explicit owner approval and a tested rollback plan.

## 4. Change safety
This audit file is documentation only. It does not change application code, migrations, production data, the `main` branch or the production Render service. Preview auto-deploy is disabled, so this documentation commit will not deploy the application.
