# 01 – Requirements

## 1. Purpose
A multi-tenant POS backend for Kenyan shops. A cashier creates an order,
the customer pays by M-Pesa STK Push, and the system automatically issues
a KRA eTIMS tax invoice.

## 2. Actors
| Actor | Description |
|---|---|
| Owner | Registers the shop, manages members, sees everything |
| Manager | Manages products, inventory, sees orders and reports |
| Cashier | Creates orders and initiates payments |
| Customer | Pays via M-Pesa (does not log in) |
| Safaricom Daraja | External: sends STK Push and callbacks |
| KRA eTIMS | External: receives and validates invoices |
| System (worker) | Internal: processes events and retries |

## 3. Functional requirements

### FR-AUTH Authentication & authorization
- FR-AUTH-1: A user can register with email and password.
- FR-AUTH-2: A user can log in and receive a JWT access token.
- FR-AUTH-3: Passwords are stored hashed (argon2 or bcrypt), never in plain text.
- FR-AUTH-4: Endpoints are protected by role (RBAC).

### FR-TEN Shops & tenant isolation
- FR-TEN-1: A user can create a shop and becomes its OWNER.
- FR-TEN-2: An owner can add or remove members and assign roles.
- FR-TEN-3: A user can belong to many shops with a different role in each.
- FR-TEN-4: Every request operates in exactly one shop context.
- FR-TEN-5: A user can never read or modify another shop's data.

### FR-PROD Products
- FR-PROD-1: Create, read, update and deactivate products (name, SKU, price, tax category).
- FR-PROD-2: SKU is unique within a shop.
- FR-PROD-3: Deactivated products cannot be added to new orders.

### FR-INV Inventory
- FR-INV-1: Each product has a current stock quantity.
- FR-INV-2: Every stock change is recorded as an inventory movement (audit trail).
- FR-INV-3: Stock can never go below zero.
- FR-INV-4: Managers can manually adjust stock with a reason.

### FR-ORD Orders
- FR-ORD-1: A cashier creates an order with one or more items.
- FR-ORD-2: Item prices are copied onto the order (price snapshot) so later product price changes do not alter old orders.
- FR-ORD-3: Creating an order deducts stock atomically (all or nothing).
- FR-ORD-4: Order statuses: PENDING, PAID, CANCELLED, EXPIRED.
- FR-ORD-5: A PENDING order that is not paid within N minutes becomes EXPIRED and stock is restored.
- FR-ORD-6: A cancelled or expired order restores stock.
- FR-ORD-7: Order creation is idempotent via an `Idempotency-Key` header.

### FR-PAY Payments
- FR-PAY-1: A payment is created for an order, and each try is a PaymentAttempt.
- FR-PAY-2: A cashier can initiate an STK Push to a customer's phone number.
- FR-PAY-3: The system receives the Daraja callback and updates the attempt.
- FR-PAY-4: Callback processing is idempotent (the same callback twice has the same effect as once).
- FR-PAY-5: On success, the payment becomes SUCCESS and the order becomes PAID, in one transaction.
- FR-PAY-6: On failure or cancellation, the order stays PENDING so the cashier can retry.
- FR-PAY-7: Every raw callback is stored for audit and debugging.
- FR-PAY-8: Payment statuses: INITIATED, PENDING, SUCCESS, FAILED, CANCELLED, TIMEOUT.
- FR-PAY-9: Payment amount must equal the order total.

### FR-INVC Invoicing
- FR-INVC-1: A successful payment automatically triggers invoice creation.
- FR-INVC-2: Invoice submission to eTIMS runs asynchronously and must never block payment confirmation.
- FR-INVC-3: Failed submissions are retried with exponential backoff.
- FR-INVC-4: After the maximum retries, the message moves to a dead-letter queue and the invoice is marked FAILED.
- FR-INVC-5: Invoice statuses: PENDING, SUBMITTED, ACCEPTED, REJECTED, FAILED.
- FR-INVC-6: Each submission try is recorded as an InvoiceAttempt.

### FR-EVT Reliable events
- FR-EVT-1: Domain events are written to an outbox table in the same DB transaction as the state change.
- FR-EVT-2: A publisher moves outbox events to RabbitMQ and marks them as published.
- FR-EVT-3: Consumers are idempotent, since the same message may be delivered more than once.

### FR-REC Reconciliation & audit
- FR-REC-1: A scheduled job finds payments stuck in PENDING and queries Daraja for their real status.
- FR-REC-2: A scheduled job finds paid orders without an accepted invoice and re-triggers invoicing.
- FR-REC-3: Important actions (login, stock adjustments, payment state changes) are written to an audit log.

## 4. Non-functional requirements
| ID | Requirement |
|---|---|
| NFR-1 | Security: HTTPS in production, JWT expiry, validated DTOs, secrets only in env vars |
| NFR-2 | Webhook security: callback endpoint accepts only expected payload shape, validated and logged. Extra protection such as an unguessable callback path token or IP allow-listing is considered |
| NFR-3 | Consistency: order, payment and stock changes use database transactions |
| NFR-4 | Reliability: no lost events (outbox), no duplicate effects (idempotency) |
| NFR-5 | Observability: structured logs with a correlation ID per request |
| NFR-6 | Testability: external providers sit behind interfaces so mocks can replace them |
| NFR-7 | Performance: list endpoints are paginated |
| NFR-8 | Portability: the whole stack runs locally via Docker Compose |

## 5. Out of scope (for now)
- Frontend or mobile app
- Card payments, cash payments, split payments
- Refunds and returns
- Multi-branch inventory
- Customer accounts and loyalty
- Reports and dashboards

## 6. Assumptions
- Amounts are in KES, whole shillings.
- One payment method (M-Pesa STK Push) at first.
- eTIMS integration details depend on KRA's current API access for your business type. We code against an `EtimsProvider` interface and verify the real contract in MVP 4.