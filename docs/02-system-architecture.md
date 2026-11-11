# 03 – Database Design

## 1. ERD

``````mermaid
erDiagram
    USER ||--o{ SHOP_MEMBER : "belongs to shops via"
    SHOP ||--o{ SHOP_MEMBER : "has members"
    SHOP ||--o{ PRODUCT : owns
    SHOP ||--o{ ORDER : owns
    SHOP ||--o{ OUTBOX_EVENT : owns
    SHOP ||--o{ AUDIT_LOG : owns
    USER ||--o{ ORDER : "created by (cashier)"
    PRODUCT ||--o{ INVENTORY_MOVEMENT : "stock history"
    PRODUCT ||--o{ ORDER_ITEM : "sold as"
    ORDER ||--|{ ORDER_ITEM : contains
    ORDER ||--o{ PAYMENT : "paid by"
    PAYMENT ||--o{ PAYMENT_ATTEMPT : "tried via"
    PAYMENT_ATTEMPT ||--o{ CALLBACK_LOG : "receives"
    ORDER ||--o| INVOICE : "invoiced as"
    INVOICE ||--o{ INVOICE_ATTEMPT : "submitted via"

    USER {
        uuid id PK
        string email UK
        string passwordHash
        string fullName
        datetime createdAt
    }
    SHOP {
        uuid id PK
        string name
        string kraPin
        string businessType
        datetime createdAt
    }
    SHOP_MEMBER {
        uuid id PK
        uuid userId FK
        uuid shopId FK
        enum role "OWNER MANAGER CASHIER"
        datetime createdAt
    }
    PRODUCT {
        uuid id PK
        uuid shopId FK
        string name
        string sku "UK with shopId"
        int priceKes
        enum taxCategory "VAT_16 ZERO_RATED EXEMPT"
        int stockQty
        boolean isActive
        datetime createdAt
    }
    INVENTORY_MOVEMENT {
        uuid id PK
        uuid shopId FK
        uuid productId FK
        int quantityChange "negative for sales"
        enum reason "RESTOCK SALE ADJUSTMENT ORDER_CANCELLED"
        uuid orderId "nullable"
        uuid createdById FK
        datetime createdAt
    }
    ORDER {
        uuid id PK
        uuid shopId FK
        uuid createdById FK
        string orderNumber "UK with shopId"
        enum status "PENDING PAID CANCELLED EXPIRED"
        int totalKes
        string idempotencyKey "UK with shopId"
        datetime expiresAt
        datetime paidAt
        datetime createdAt
    }
    ORDER_ITEM {
        uuid id PK
        uuid orderId FK
        uuid productId FK
        string productName "snapshot"
        int unitPriceKes "snapshot"
        enum taxCategory "snapshot"
        int quantity
        int lineTotalKes
    }
    PAYMENT {
        uuid id PK
        uuid shopId FK
        uuid orderId FK
        int amountKes
        enum status "INITIATED PENDING SUCCESS FAILED CANCELLED TIMEOUT"
        string mpesaReceipt "nullable, UK"
        datetime createdAt
        datetime completedAt
    }
    PAYMENT_ATTEMPT {
        uuid id PK
        uuid paymentId FK
        string phoneNumber
        string merchantRequestId UK
        string checkoutRequestId UK
        enum status "PENDING SUCCESS FAILED CANCELLED TIMEOUT"
        string resultCode
        string resultDesc
        datetime createdAt
    }
    CALLBACK_LOG {
        uuid id PK
        uuid paymentAttemptId FK "nullable"
        string checkoutRequestId
        json rawPayload
        boolean processed
        datetime receivedAt
    }
    INVOICE {
        uuid id PK
        uuid shopId FK
        uuid orderId FK "UK"
        string invoiceNumber
        enum status "PENDING SUBMITTED ACCEPTED REJECTED FAILED"
        int totalKes
        int taxKes
        string etimsReference "nullable"
        datetime createdAt
    }
    INVOICE_ATTEMPT {
        uuid id PK
        uuid invoiceId FK
        int attemptNo
        enum status "SUCCESS FAILED"
        json requestPayload
        json responsePayload
        string errorMessage
        datetime createdAt
    }
    OUTBOX_EVENT {
        uuid id PK
        uuid shopId FK
        string aggregateType
        uuid aggregateId
        string eventType "e.g. payment.succeeded"
        json payload
        enum status "PENDING PUBLISHED FAILED"
        int retryCount
        datetime createdAt
        datetime publishedAt
    }
    AUDIT_LOG {
        uuid id PK
        uuid shopId FK
        uuid actorId FK "nullable"
        string action
        string entityType
        uuid entityId
        json metadata
        datetime createdAt
    }
``````

## 2. Key constraints

| Table | Constraint | Purpose |
|---|---|---|
| SHOP_MEMBER | UNIQUE(userId, shopId) | A user has one role per shop |
| PRODUCT | UNIQUE(shopId, sku) | SKU unique per shop, not globally |
| PRODUCT | CHECK(stockQty >= 0) | Stock never negative (FR-INV-3) |
| ORDER | UNIQUE(shopId, idempotencyKey) | Duplicate create-order requests return the same order |
| ORDER | UNIQUE(shopId, orderNumber) | Human-readable order numbers |
| PAYMENT_ATTEMPT | UNIQUE(checkoutRequestId) | Callback idempotency, since Daraja identifies attempts by it |
| PAYMENT | UNIQUE(mpesaReceipt) | The same M-Pesa receipt cannot be recorded twice |
| INVOICE | UNIQUE(orderId) | One invoice per order |

## 3. Tenant isolation rule
Every table except USER, and the tables reached only through a parent (ORDER_ITEM,
PAYMENT_ATTEMPT, CALLBACK_LOG, INVOICE_ATTEMPT), carries a `shopId`.
Every query in the application must filter by `shopId`.

## 4. State machines

Order:   PENDING -> PAID | CANCELLED | EXPIRED
Payment: INITIATED -> PENDING -> SUCCESS | FAILED | CANCELLED | TIMEOUT
Invoice: PENDING -> SUBMITTED -> ACCEPTED | REJECTED, and PENDING/SUBMITTED -> FAILED after max retries

Transitions out of terminal states (PAID, SUCCESS, ACCEPTED) are forbidden.
``````
``````

**What this file does:** It defines the tables Prisma will model. A few choices are worth understanding:

- **Order and payment are separate tables.** A customer's first STK Push may fail or be cancelled. The same order then needs another payment try without losing the history of the first.
- **Payment and PaymentAttempt are separate tables.** `Payment` is the business-level intent ("pay KES 500 for this order") and `PaymentAttempt` is one concrete STK Push request.
- **The snapshot fields on `ORDER_ITEM` are intentional duplication.** If you change a product's price next week, last week's receipts must not change.
- **`CALLBACK_LOG` stores the raw payload.** When something goes wrong in production, this is how you find out what Safaricom actually sent.
- **The unique constraints do real work.** `UNIQUE(checkoutRequestId)` and `UNIQUE(mpesaReceipt)` are your last line of defence if your code has an idempotency bug, because the database refuses the duplicate.

---

## File 3: `docs/02-system-architecture.md`

``````markdown
# 02 – System Architecture

## 1. Style
Modular monolith. One NestJS codebase, split into modules with clear
responsibilities, deployed as two processes:
- `api`    – the HTTP server
- `worker` – consumes RabbitMQ messages and runs scheduled jobs

## 2. Component diagram

`````mermaid
flowchart TB
    Client["Client / POS app / Postman"]
    Daraja["Safaricom Daraja"]
    Etims["KRA eTIMS"]

    subgraph API["API process (NestJS)"]
        direction TB
        Auth["AuthModule<br/>register, login, JWT, guards"]
        Shops["ShopsModule<br/>shops, members, tenant context"]
        Products["ProductsModule"]
        Inventory["InventoryModule"]
        Orders["OrdersModule"]
        Payments["PaymentsModule<br/>payments, attempts, callbacks"]
        Outbox["OutboxModule<br/>write events + publisher"]
        Audit["AuditModule"]
        Prisma["PrismaModule"]
        PayProv["PaymentProvider<br/>interface: Mock or Daraja"]
    end

    subgraph WORKER["Worker process (NestJS)"]
        direction TB
        Consumer["Invoice consumer"]
        Invoicing["InvoicingModule"]
        EtimsProv["EtimsProvider<br/>interface: Mock or KRA"]
        Recon["ReconciliationModule<br/>scheduled jobs"]
    end

    DB[("PostgreSQL")]
    MQ{{"RabbitMQ<br/>invoice.queue, retry queue, DLQ"}}

    Client -->|HTTPS REST| Auth
    Client --> Products
    Client --> Orders
    Client --> Payments
    Orders --> Inventory
    Orders --> Payments
    Payments --> PayProv
    PayProv -->|STK Push| Daraja
    Daraja -->|callback webhook| Payments
    Payments --> Outbox
    Outbox -->|publish| MQ
    MQ -->|deliver| Consumer
    Consumer --> Invoicing
    Invoicing --> EtimsProv
    EtimsProv -->|submit invoice| Etims
    Recon --> Payments
    Recon --> Invoicing

    Auth --> Prisma
    Shops --> Prisma
    Products --> Prisma
    Inventory --> Prisma
    Orders --> Prisma
    Payments --> Prisma
    Outbox --> Prisma
    Invoicing --> Prisma
    Prisma --> DB
`````

## 3. Module responsibilities

| Module | Owns | Depends on |
|---|---|---|
| Config | Environment variables, validation | – |
| Prisma | DB connection, transactions | Config |
| Auth | Users, login, JWT strategy, role and tenant guards | Prisma |
| Shops | Shops, members, tenant context | Prisma |
| Products | Product CRUD | Prisma |
| Inventory | Stock movements, stock checks | Prisma |
| Orders | Order lifecycle | Products, Inventory, Outbox |
| Payments | Payment lifecycle, callbacks, idempotency | Orders, PaymentProvider, Outbox |
| Outbox | Writing events, publishing to RabbitMQ | Prisma, Messaging |
| Messaging | RabbitMQ connection, queue topology | Config |
| Invoicing | Invoice lifecycle, retry logic | EtimsProvider, Prisma |
| Reconciliation | Scheduled recovery jobs | Payments, Invoicing |
| Audit | Audit log writes | Prisma |

## 4. Communication rules

1. **Synchronous (direct service calls via dependency injection)** is used inside one
   transaction boundary: Orders -> Inventory, Payments -> Orders.
2. **Asynchronous (events through outbox and RabbitMQ)** is used whenever work can happen
   later or can fail independently: payment confirmed -> invoice.
3. **External systems are always behind interfaces** (`PaymentProvider`, `EtimsProvider`).
   Business modules never import Daraja or KRA code directly.
4. **Modules do not touch each other's tables.** Orders asks InventoryService to deduct
   stock and never writes to the movement table itself.
5. **Tenant context** is resolved once per request by a guard and passed down. Services never
   trust a `shopId` from the request body.

## 5. Request pipeline (NestJS)

Request -> Logging interceptor -> JwtAuthGuard -> TenantGuard -> RolesGuard
-> ValidationPipe (DTO) -> Controller -> Service -> Prisma
-> Exception filter -> Response

## 6. Queue topology

| Queue | Purpose |
|---|---|
| `invoice.submit` | Main queue the worker consumes |
| `invoice.retry` | Holds failed messages for a delay (TTL), then routes back to `invoice.submit` |
| `invoice.dlq` | Messages that exhausted retries, kept for manual inspection |
`````
`````

**What this file does:** It shows who talks to whom, and the rules that keep the codebase clean. Rule 4 (modules do not touch each other's tables) is what separates a maintainable monolith from a tangled one. Rule 3 (providers behind interfaces) is what lets you build with mocks first, as your roadmap recommends. The request pipeline in section 5 is a map of the NestJS concepts you will learn: interceptors, guards, pipes, filters.

---

## File 4: `docs/05-business-workflows.md` (sequence diagrams)

`````markdown
# 05 – Business Workflows

## 1. Create order

````mermaid
sequenceDiagram
    actor C as Cashier
    participant API as OrdersController
    participant OS as OrdersService
    participant INV as InventoryService
    participant DB as PostgreSQL

    C->>API: POST /orders (Idempotency-Key, items)
    API->>API: JwtGuard, TenantGuard, RolesGuard, validate DTO
    API->>OS: createOrder(shopId, userId, dto)
    OS->>DB: find order by (shopId, idempotencyKey)
    alt order already exists
        DB-->>OS: existing order
        OS-->>C: 200 existing order (no duplicate)
    else new order
        OS->>DB: BEGIN TRANSACTION
        OS->>DB: load products (shopId, active only)
        OS->>INV: deduct stock for each item
        INV->>DB: UPDATE stock WHERE stockQty >= qty
        alt insufficient stock
            INV-->>OS: error
            OS->>DB: ROLLBACK
            OS-->>C: 409 Insufficient stock
        else stock ok
            OS->>DB: INSERT order (PENDING) with price snapshots
            OS->>DB: INSERT order items and inventory movements
            OS->>DB: COMMIT
            OS-->>C: 201 order status PENDING
        end
    end
````

## 2. Payment (STK Push and callback)

````mermaid
sequenceDiagram
    actor C as Cashier
    participant PS as PaymentsService
    participant PP as PaymentProvider
    participant D as Daraja
    actor U as Customer phone
    participant CB as CallbackController
    participant DB as PostgreSQL
    participant OB as Outbox

    C->>PS: POST /orders/:id/pay (phone)
    PS->>DB: load order, must be PENDING and not expired
    PS->>DB: create Payment (INITIATED) and PaymentAttempt
    PS->>PP: initiatePayment(amount, phone, reference)
    PP->>D: STK Push request
    D-->>PP: MerchantRequestID, CheckoutRequestID
    PP-->>PS: accepted
    PS->>DB: attempt PENDING, store request IDs
    PS-->>C: 202 payment pending
    D->>U: prompt for M-Pesa PIN
    U-->>D: enters PIN

    D->>CB: POST /webhooks/daraja (result)
    CB->>DB: store raw CallbackLog
    CB-->>D: 200 OK (respond fast)
    CB->>PS: handleCallback(payload)
    PS->>DB: BEGIN TRANSACTION
    PS->>DB: lock attempt by CheckoutRequestID
    alt attempt already finalised
        PS->>DB: ROLLBACK, ignore duplicate callback
    else ResultCode is 0 (success)
        PS->>DB: attempt SUCCESS, payment SUCCESS with receipt
        PS->>DB: order PAID, set paidAt
        PS->>OB: insert event payment.succeeded
        PS->>DB: COMMIT
    else failed or cancelled
        PS->>DB: attempt FAILED or CANCELLED, payment updated
        PS->>DB: order stays PENDING
        PS->>DB: COMMIT
    end
````

Note: if the callback never arrives, the reconciliation job (workflow 4) calls
`queryPaymentStatus` and completes the same transition.

## 3. Invoicing (outbox, RabbitMQ and retries)

````mermaid
sequenceDiagram
    participant OB as Outbox table
    participant PUB as OutboxPublisher
    participant MQ as RabbitMQ
    participant W as InvoiceWorker
    participant IS as InvoicingService
    participant E as EtimsProvider
    participant DB as PostgreSQL

    loop every few seconds
        PUB->>OB: fetch PENDING events
        PUB->>MQ: publish to invoice.submit
        PUB->>OB: mark PUBLISHED
    end

    MQ->>W: deliver payment.succeeded
    W->>IS: processInvoice(orderId)
    IS->>DB: find or create Invoice (unique per order)
    alt invoice already ACCEPTED
        IS-->>W: nothing to do
        W->>MQ: ack
    else needs submission
        IS->>E: submitInvoice(payload)
        alt success
            E-->>IS: etimsReference
            IS->>DB: attempt SUCCESS, invoice ACCEPTED
            W->>MQ: ack
        else temporary failure
            E-->>IS: error or timeout
            IS->>DB: record failed attempt
            alt attempts below max
                W->>MQ: send to invoice.retry (delay TTL)
                MQ-->>MQ: after delay, back to invoice.submit
            else attempts exhausted
                W->>MQ: send to invoice.dlq
                IS->>DB: invoice FAILED
            end
        end
    end
````

## 4. Reconciliation jobs

````mermaid
sequenceDiagram
    participant CR as Scheduler (cron)
    participant PS as PaymentsService
    participant PP as PaymentProvider
    participant IS as InvoicingService
    participant DB as PostgreSQL

    CR->>PS: reconcile pending payments
    PS->>DB: find attempts PENDING older than 2 minutes
    loop each stale attempt
        PS->>PP: queryPaymentStatus(checkoutRequestId)
        PP-->>PS: final status
        PS->>PS: apply same transition as callback (idempotent)
    end

    CR->>IS: reconcile invoices
    IS->>DB: find PAID orders with no ACCEPTED invoice
    IS->>DB: insert payment.succeeded event again via outbox
    CR->>PS: expire unpaid orders
    PS->>DB: PENDING orders past expiresAt become EXPIRED, restore stock
````

## 5. Failure scenarios we must test later

| Scenario | Expected result |
|---|---|
| Same create-order request sent twice | One order only |
| Two cashiers sell the last item at once | One succeeds, one gets 409 |
| Daraja sends the same callback twice | Order paid once, one outbox event |
| Callback never arrives | Reconciliation completes the payment |
| Callback arrives for unknown CheckoutRequestID | Stored in CallbackLog, no state change |
| Callback amount differs from order total | Payment flagged, order not auto-paid |
| RabbitMQ is down when payment succeeds | Payment still confirmed, event published later |
| eTIMS is down | Retries, then DLQ, payment is unaffected |
| User from shop A requests shop B's order | 404 or 403 |
````
````

**What this file does:** It turns the requirements into step-by-step behaviour. These are the most important concepts to take from the diagrams:

- **Diagram 1 (orders):** The stock deduction and order insert happen in one transaction. A failure halfway rolls everything back, which is what "atomic" means in practice.
- **Diagram 2 (payments):** The callback endpoint answers Safaricom immediately, then processes. If your endpoint is slow, Daraja may retry the callback, and that is exactly why we need idempotency. The `payment.succeeded` event is written inside the same transaction that marks the order PAID.
- **Diagram 3 (invoicing):** This is the transactional outbox pattern. You cannot reliably "update the database and publish to RabbitMQ" as two separate steps, because one can succeed while the other fails. Writing the event to the database in the same transaction guarantees it exists, and a separate publisher delivers it later.
- **Diagram 4 (reconciliation):** Distributed systems lose messages, and this is the safety net that repairs the gaps.

---

## Next steps

**1. Review these four documents.** Look in particular at the stock-reservation approach and the one-database multi-tenancy choice, since both are easier to change now than after coding.

**2. Install the tools we will need.** Install these now so Module 1 starts smoothly:
- **Node.js 20 or 22 LTS** (check with `node -v`)
- **Docker Desktop**, which will run PostgreSQL and later RabbitMQ
- **Git** and a **GitHub account**
- **VS Code**, with the Prisma and ESLint extensions
- **Postman** or **Bruno** for testing endpoints

**3. Start Module 1 (project setup).** I'll walk you through `nest new`, Docker Compose for PostgreSQL, Prisma setup, config validation, and a health-check endpoint, with an explanation of every file.

Do you want to change anything in the design, or should we move on to the project setup?