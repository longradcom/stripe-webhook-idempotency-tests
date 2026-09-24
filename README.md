# Stripe webhook idempotency tests

Runnable acceptance tests for the part of a Stripe webhook handler that is easy to get wrong: retries, duplicates and partial failure.

The tests don't look inside your handler. They send it signed requests the way Stripe does, including retries, simultaneous copies and deliveries that fail halfway, and then count how many times the business effect actually happened. A handler that passes has the behaviour you want, not just the right-looking shape.

```text
 ✓ a redelivered event is acknowledged and applied once
 ✓ a delivery that failed after being recorded is applied when Stripe retries it
 ✓ a delivery that crashed after its effect is not applied twice on retry
 ✓ simultaneous copies of one event apply it once
 ✓ two different events for the same invoice apply its effect once
 ✓ a badly signed delivery is rejected and does not block the genuine one
 ✓ the signature is checked against the raw body, not a re-serialised one
 ✓ an event type the handler does not act on is acknowledged and changes nothing
```

## The bug this exists for

The usual way to deduplicate webhooks:

```sql
insert into webhook_events (id) values ($1) on conflict (id) do nothing
-- zero rows? we've seen it before: return 200
```

Now suppose the database times out between that insert and the work. The endpoint correctly returns 500, and Stripe retries. The retry's insert conflicts, the handler decides it's a duplicate, and it returns 200. Stripe stops retrying. The customer paid, the event was never applied, and nothing logged an error.

The handler remembered *seeing* the event and forgot that it never *applied* it. A test that checks for a unique index passes on this handler. A test that counts outcomes after a failed delivery doesn't:

```text
AssertionError: The effect for in_test_43c2… was applied 0 time(s) after a failed delivery
and its retry. If this is 0, the retry was treated as a duplicate because the event id had
already been recorded: the handler remembered seeing the event and forgot that it never
applied it.
```

There's a longer write-up [on the Udria blog](https://udria.co/blog/stripe-webhook-idempotency?utm_source=github&utm_medium=referral&utm_campaign=webhook-idempotency-tests).

## Try it

```bash
git clone <this repository>
cd stripe-webhook-idempotency-tests
npm install
npm test
```

No database to set up and no Stripe account needed. The examples use [PGlite](https://pglite.dev), an in-process Postgres, and sign requests with the Stripe SDK's own test signer.

`npm test` runs the suite against three example handlers in [`examples/handlers.ts`](examples/handlers.ts):

| Handler | What it does | Caught by |
| --- | --- | --- |
| `transactionalHandler` | Records the event and applies the effect in one transaction, with the effect keyed by invoice | Passes everything |
| `seenIsProcessedHandler` | The `on conflict do nothing` pattern above | `retry-after-failure`, `one-effect-per-invoice` |
| `checkThenActHandler` | The usual fix: a status column, skipping events marked processed | `crash-after-effect`, `concurrent-duplicates`, `one-effect-per-invoice` |

[`tests/catches-known-bugs.test.ts`](tests/catches-known-bugs.test.ts) asserts that table. Every property has to catch the bug it was written for, or the build fails.

To see the failure messages yourself:

```bash
npm run demo:seen-is-processed
npm run demo:check-then-act
```

## Run it against your own handler

**1. Copy the suite.** Copy the four files in [`src/`](src) into your test directory. They depend only on `stripe` and `vitest`, which you probably already have. There's nothing to install from us.

**2. Write an adapter.** It needs three functions: send a request to your route, count the effect, and reset state. For a Next.js route handler:

```ts
// tests/stripe-webhook.idempotency.test.ts
import { describeWebhookIdempotency } from "./webhook-idempotency/suite";
import { POST } from "@/app/api/stripe/webhook/route";
import { db } from "@/lib/db"; // your test database

const WEBHOOK_SECRET = "whsec_test_idempotency_suite";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET; // whatever your route reads

describeWebhookIdempotency("POST /api/stripe/webhook", {
  webhookSecret: WEBHOOK_SECRET,
  customerId: "cus_test_1",
  setup: () => ({
    async deliver({ rawBody, signature }) {
      const response = await POST(
        new Request("http://localhost/api/stripe/webhook", {
          method: "POST",
          body: rawBody,
          headers: { "stripe-signature": signature },
        }),
      );
      return response.status;
    },

    // What does invoice.paid do in your app? Count it, per invoice.
    async effectCount(invoiceId) {
      const rows = await db.query("select count(*)::int as n from credit_grants where invoice_id = $1", [invoiceId]);
      return rows[0].n;
    },

    async reset() {
      await db.query("truncate credit_grants, webhook_events, accounts cascade");
      await db.query("insert into accounts (id, stripe_customer_id) values ('acct_1', 'cus_test_1')");
    },
  }),
});
```

The suite sends `invoice.paid` for `customerId`. Seed that customer in `reset()` so your handler has an account to apply the effect to. If your handler reacts to a different event, change `invoicePaid()` in `events.ts`.

**3. Optional, but recommended: add fault injection.** Two properties need to make a delivery fail partway through. Without that they're reported as skipped, and they're the two most likely to find something. Your handler needs two lines it calls in production and that do nothing there:

```ts
faults.hit("after-receipt"); // after recording the event, before the effect
// ... apply the effect ...
faults.hit("after-effect"); // after the effect, before recording that it finished
```

[`examples/faults.ts`](examples/faults.ts) is the ten-line switch behind it. Then add `injectFault: (point) => faults.arm(point)` to your adapter.

**Run the concurrency property against real Postgres.** PGlite is a single connection and serialises transactions, so it can't produce every race a real database can. Point your adapter at the Postgres you run in CI for that one.

## What this doesn't check

This suite covers one part of a billing integration: delivery semantics. It doesn't check:

- how Stripe state maps onto your users, organisations and entitlements
- events that arrive out of order, or before the customer they refer to exists locally
- test-mode events reaching a live deployment
- the other webhook events a subscription lifecycle depends on, or reconciling with Stripe when a webhook never arrives
- anything that calls Stripe or another service from inside the handler

Those are covered by [Udria Production Stripe Billing](https://udria.co/?utm_source=github&utm_medium=referral&utm_campaign=webhook-idempotency-tests), the paid capability package these tests were written alongside. This repository is standalone: it doesn't need the package, and nothing here calls home.

## Licence

MIT. See [LICENSE](LICENSE).

Stripe is a trademark of Stripe, Inc. This project is independent and is not affiliated with or endorsed by Stripe.
