import assert from "node:assert/strict";
import { acknowledged, type SuiteOptions, type WebhookUnderTest } from "./contract";
import { invoicePaid, sign, unhandled } from "./events";

/**
 * The properties, as plain async checks.
 *
 * They use node:assert rather than a test framework so that the same check can
 * be run as a test (`suite.ts`) and also run against a handler that is known to
 * be wrong, to prove the check catches it (`tests/catches-known-bugs.test.ts`).
 * A property that cannot fail is not a property.
 */

export interface Context {
  target: WebhookUnderTest;
  secret: string;
  customerId: string;
}

export interface Property {
  id: string;
  title: string;
  /** Present when the property needs `injectFault`. */
  needsFaults?: true;
  check(ctx: Context): Promise<void>;
}

export const PROPERTIES: Property[] = [
  {
    id: "redelivery-after-success",
    title: "a redelivered event is acknowledged and applied once",
    async check({ target, secret, customerId }) {
      const e = invoicePaid({ customerId });

      assertAck(await target.deliver(sign(e.rawBody, secret)), "first delivery");
      assertAck(await target.deliver(sign(e.rawBody, secret)), "redelivery");

      await assertEffects(target, e.invoiceId, 1, "after one delivery and one redelivery");
    },
  },

  {
    id: "retry-after-failure",
    title: "a delivery that failed after being recorded is applied when Stripe retries it",
    needsFaults: true,
    async check({ target, secret, customerId }) {
      const e = invoicePaid({ customerId });

      target.injectFault!("after-receipt");
      const first = await target.deliver(sign(e.rawBody, secret));
      assert.ok(
        !acknowledged(first),
        `The first delivery failed inside the handler but was answered ${first}. ` +
          `A 2xx tells Stripe the event was handled, so it will never be retried.`,
      );

      assertAck(await target.deliver(sign(e.rawBody, secret)), "the retry");
      await assertEffects(
        target,
        e.invoiceId,
        1,
        "after a failed delivery and its retry. If this is 0, the retry was treated as a duplicate " +
          "because the event id had already been recorded: the handler remembered seeing the event " +
          "and forgot that it never applied it",
      );
    },
  },

  {
    id: "crash-after-effect",
    title: "a delivery that crashed after its effect is not applied twice on retry",
    needsFaults: true,
    async check({ target, secret, customerId }) {
      const e = invoicePaid({ customerId });

      target.injectFault!("after-effect");
      const first = await target.deliver(sign(e.rawBody, secret));
      assert.ok(!acknowledged(first), `The first delivery crashed inside the handler but was answered ${first}.`);

      assertAck(await target.deliver(sign(e.rawBody, secret)), "the retry");
      await assertEffects(
        target,
        e.invoiceId,
        1,
        "after a delivery that crashed after writing its effect, and its retry. If this is 2, the " +
          "effect and the processed marker are not committed together, and the effect itself is not " +
          "idempotent",
      );
    },
  },

  {
    id: "concurrent-duplicates",
    title: "simultaneous copies of one event apply it once",
    async check({ target, secret, customerId }) {
      const e = invoicePaid({ customerId });

      const statuses = await Promise.all(
        Array.from({ length: 5 }, () => target.deliver(sign(e.rawBody, secret))),
      );
      assert.ok(statuses.some(acknowledged), `No concurrent copy was acknowledged: ${statuses.join(", ")}`);

      // A copy that lost the race may answer non-2xx, and Stripe will retry it.
      // That retry must also be safe.
      assertAck(await target.deliver(sign(e.rawBody, secret)), "a later redelivery");
      await assertEffects(
        target,
        e.invoiceId,
        1,
        "after five simultaneous copies. More than 1 means two requests both concluded the event " +
          "was new: a check-then-act race, which an in-process lock cannot fix once there is more " +
          "than one server",
      );
    },
  },

  {
    id: "one-effect-per-invoice",
    title: "two different events for the same invoice apply its effect once",
    async check({ target, secret, customerId }) {
      // Deduplicating on the event id is transport-level idempotency. It does
      // nothing when two distinct events describe the same business fact. The
      // common case is a handler that grants access on both invoice.paid and
      // invoice.payment_succeeded, or on both checkout.session.completed and the
      // first invoice.paid: two event ids, one payment. The effect itself needs
      // a key, and the invoice id is the natural one.
      const first = invoicePaid({ customerId });
      const second = invoicePaid({ customerId, invoiceId: first.invoiceId });
      assert.notEqual(first.id, second.id);

      assertAck(await target.deliver(sign(first.rawBody, secret)), "the first event");
      assertAck(await target.deliver(sign(second.rawBody, secret)), "the second event");

      await assertEffects(
        target,
        first.invoiceId,
        1,
        "after two distinct events for one invoice. The business effect needs its own " +
          "idempotency key (the invoice id), not just the event ledger",
      );
    },
  },

  {
    id: "rejects-bad-signature",
    title: "a badly signed delivery is rejected and does not block the genuine one",
    async check({ target, secret, customerId }) {
      const e = invoicePaid({ customerId });

      const forged = await target.deliver(sign(e.rawBody, "whsec_not_your_secret"));
      assert.equal(forged, 400, `A delivery signed with the wrong secret was answered ${forged}, not 400.`);
      await assertEffects(target, e.invoiceId, 0, "after a forged delivery");

      // A handler that records the event id before verifying the signature lets
      // anyone who can guess an id make the genuine delivery look like a duplicate.
      assertAck(await target.deliver(sign(e.rawBody, secret)), "the genuine delivery after a forged one");
      await assertEffects(target, e.invoiceId, 1, "after the genuine delivery that followed a forged one");
    },
  },

  {
    id: "verifies-raw-body",
    title: "the signature is checked against the raw body, not a re-serialised one",
    async check({ target, secret, customerId }) {
      const e = invoicePaid({ customerId });

      // Stripe sends pretty-printed JSON. A handler that parses the body and
      // then verifies JSON.stringify(body) is checking different bytes and
      // rejects every genuine delivery.
      assertAck(await target.deliver(sign(e.rawBody, secret)), "a genuine pretty-printed delivery");

      const other = invoicePaid({ customerId });
      const signed = sign(other.rawBody, secret);
      const tampered = signed.rawBody.replace('"amount_paid": 2000', '"amount_paid": 1');
      assert.notEqual(tampered, signed.rawBody);
      const status = await target.deliver({ rawBody: tampered, signature: signed.signature });
      assert.equal(status, 400, `A body altered after signing was answered ${status}, not 400.`);
      await assertEffects(target, other.invoiceId, 0, "after a tampered delivery");
    },
  },

  {
    id: "ignores-unhandled-types",
    title: "an event type the handler does not act on is acknowledged and changes nothing",
    async check({ target, secret, customerId }) {
      // Stripe adds event types all the time. Answering non-2xx to one you do not
      // handle means Stripe retries it for up to three days and eventually
      // disables the endpoint.
      const e = unhandled({ customerId });
      assertAck(await target.deliver(sign(e.rawBody, secret)), `an unhandled ${e.type} event`);
      await assertEffects(target, e.invoiceId, 0, "after an unhandled event type");
    },
  },
];

export function context(options: SuiteOptions, target: WebhookUnderTest): Context {
  return { target, secret: options.webhookSecret, customerId: options.customerId };
}

function assertAck(status: number, what: string) {
  assert.ok(acknowledged(status), `Expected ${what} to be acknowledged with a 2xx, got ${status}.`);
}

async function assertEffects(target: WebhookUnderTest, invoiceId: string, expected: number, when: string) {
  const actual = await target.effectCount(invoiceId);
  assert.equal(actual, expected, `The effect for ${invoiceId} was applied ${actual} time(s) ${when}.`);
}
