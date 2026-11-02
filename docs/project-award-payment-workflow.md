# MMC Project Award, Purchase Order & Payment Workflow

## Scope boundary
This is a project-side workflow. It is not MMC subscription billing.
The existing \`invoices\` table and all subscription routes remain unchanged.
MMC administrators manage platform accounts and subscriptions only. They cannot
approve project invoices, authorize project payments, or record project disbursements.

## Existing integration points found
- \`project_requests\` represents the buyer-side project request.
- \`requests/:id/tender\` publishes the tender and links it to the request.
- \`tenders\` and \`bid_submissions\` support tender publication, submissions,
  technical evaluation, and financial unlocking.
- Organization membership currently supports \`manager\`, \`requester\`,
  \`projects\`, and \`procurement\`.
- Files already use the storage abstraction and request documents.
- Organization audit events exist, but the new workflow needs entity-specific
  audit rows and immutable financial event history.

## Proposed lifecycle
1. Procurement/authorized award committee records the award only after the
   existing evaluation and award decision are complete.
2. The award links the tender, buyer organization, and winning contractor user.
3. Procurement drafts a PO and its line items. Draft/pending POs are invisible
   to the contractor.
4. An authorized procurement manager approves the PO. Only then can it be issued
   and become visible to the winning contractor.
5. Contractor submits a materials invoice, progress statement, or final invoice
   against the issued PO, with line items and supporting documents.
6. Procurement checks quantities, rates, PO balance, delivery/acceptance evidence.
   It can accept, return with reasons, or reject.
7. The Owner/requester confirms delivery or progress where the contract requires it.
8. Procurement/Owner forwards the reviewed invoice to Finance.
9. Finance independently checks the financial documents, approves for payment,
   and records one or more payments with dates and references.
10. Remaining balance is derived from approved invoice amount minus recorded
    payments. Paid/part-paid states are calculated from those values.

## Role boundary matrix
| Action | Contractor | Procurement | Owner/requester | Finance | MMC admin |
|---|---:|---:|---:|---:|---:|
| View issued PO for own award | Yes | Yes | Yes | As scoped | No project override |
| Draft PO | No | Yes | No | No | No |
| Approve/issue PO | No | Authorized approver | No | No | No |
| Submit project invoice | Yes, own award | No | No | No | No |
| Review quantities/PO match | No | Yes | Confirm where required | Read reviewed record | No |
| Return invoice for correction | No | Yes | Where authorized | No | No |
| Forward to Finance | No | Yes/Owner | Yes | No | No |
| Approve project payment | No | No | No | Yes | No |
| Record payment | No | No | No | Yes | No |
| Manage MMC subscriptions | No | No | No | No | Yes |

Finance must be a scoped organization role, never a platform-admin role.
MMC admin must not be treated as a fallback approver.

## Additive database module
\`server/src/project-finance/schema.js\` defines a separate, additive schema:
- project_awards
- purchase_orders / purchase_order_items
- project_invoices / project_invoice_items
- project_invoice_reviews
- project_payments
- project_invoice_documents
- project_audit_events

It deliberately does not reference, rename, or alter the subscription \`invoices\` table.
It is not wired into the production migration runner.

## Required API design before enabling the workflow
- POST /api/project-awards (authorized buyer-side award role)
- GET /api/project-awards and GET /api/project-awards/:id (organization scope)
- POST /api/project-awards/:id/purchase-orders
- POST /api/purchase-orders/:id/submit-approval
- POST /api/purchase-orders/:id/approve
- POST /api/purchase-orders/:id/issue
- GET /api/purchase-orders (contractor sees only issued POs linked to their user)
- POST /api/purchase-orders/:id/invoices (winning contractor only)
- POST /api/project-invoices/:id/procurement-review
- POST /api/project-invoices/:id/owner-confirmation
- POST /api/project-invoices/:id/forward-to-finance
- POST /api/project-invoices/:id/finance-approval
- POST /api/project-invoices/:id/payments (Finance only)
- GET /api/project-invoices/:id (strict organization/contractor scope)

Every mutating endpoint must run in a DB transaction and write
\`project_audit_events\`. Invoice and payment totals must be recalculated server-side;
never trust client-supplied totals or status values.

## Mandatory invariants
- Project invoice records are never stored in subscription \`invoices\`.
- No PO is visible to a contractor before approval and issue.
- Contractor can access only POs/invoices belonging to their awarded contract.
- PO line totals and invoice line totals are calculated server-side.
- Cumulative invoices cannot exceed the PO's approved value, except through a
  formally approved PO amendment (not included in this first increment).
- Cumulative payments cannot exceed the approved invoice net amount.
- Finance cannot approve until procurement review and any required Owner
  confirmation have been recorded.
- Only Finance can create payment records.
- MMC admin has no project-finance approval or payment permission.
- All review, return, approval, forwarding, issue, and payment actions are audited.
- Do not hard-delete financial records; use controlled void/cancel transitions.

## Test plan (must pass before any production rollout)
1. Migration creates only the new project-finance tables and leaves existing
   subscription tables/rows unchanged.
2. Migration can be run twice safely.
3. Existing API tests pass unchanged.
4. Cross-organization reads/writes are denied.
5. Contractor A cannot view Contractor B's PO, invoice, documents, or payments.
6. Draft and pending-approval POs are hidden from contractors.
7. PO approval/issue requires the correct procurement authority.
8. Contractor cannot review, approve, forward, or pay its own invoice.
9. Procurement cannot record a payment.
10. Owner confirmation is required only where configured for the contract.
11. Finance cannot approve an invoice before required reviews.
12. Payment totals cannot exceed approved invoice net amount; partial and final
    payments update the outstanding balance correctly.
13. Invoice totals cannot exceed PO remaining value.
14. Every state transition and payment creates an audit event.
15. MMC admin cannot access project approval/payment actions.
16. Existing authentication, procurement evaluation, subscriptions, file upload,
    and all current portals remain operational.

## Current safety status
A feature branch has been created from \`main\`. The schema module is committed
only to that branch. The production \`main\` branch, Render deployment, and
production database have not been changed. No test run is claimed yet.
