/**
 * What the suite needs from your application.
 *
 * The properties in `properties.ts` never look inside your handler. They send it
 * signed HTTP requests and then ask one question of your database: how many
 * times did the business effect happen? That is deliberate. A test that checks
 * for a UNIQUE(event_id) index passes on the handler with the bug; a test that
 * counts outcomes does not.
 */

/** One HTTP request to your webhook endpoint, exactly as Stripe would send it. */
export interface Delivery {
  /** The request body, byte for byte. Verify the signature against this string. */
  rawBody: string;
  /** The value of the `Stripe-Signature` header. */
  signature: string;
}

/**
 * Where a delivery can be made to fail, once.
 *
 * - `after-receipt`: the event has been recorded as received, and the business
 *   effect has not happened yet. A database timeout here is what exposes
 *   "seen is not processed".
 * - `after-effect`: the business effect has been written, and the handler has
 *   not yet recorded that it finished. A crash here is what exposes a handler
 *   that relies on a processed flag alone.
 */
export type FaultPoint = "after-receipt" | "after-effect";

export interface WebhookUnderTest {
  /** Deliver one request to your endpoint and return the HTTP status it answered with. */
  deliver(delivery: Delivery): Promise<number>;

  /**
   * How many times the business effect for this invoice has been applied.
   *
   * The suite sends `invoice.paid` events. Your answer is whatever your handler
   * does on `invoice.paid` — rows in a credits ledger, a provisioning record, a
   * count of confirmation emails — counted per invoice id.
   */
  effectCount(invoiceId: string): Promise<number>;

  /**
   * Make the next delivery fail at `point`, once, by throwing inside the
   * handler.
   *
   * Optional. Without it the two partial-failure properties are skipped and
   * reported as skipped, which is the honest outcome: they are the two most
   * likely to find a real bug, and they cannot be checked from outside.
   */
  injectFault?(point: FaultPoint): void;

  /** Return to a clean state before each property. */
  reset(): Promise<void>;
}

export interface SuiteOptions {
  /**
   * The webhook signing secret your handler verifies against, e.g. the value of
   * STRIPE_WEBHOOK_SECRET in your test environment.
   */
  webhookSecret: string;

  /**
   * A Stripe Customer id your application maps to an account, so that
   * `invoice.paid` has somewhere to apply its effect. Seed it in `reset()`.
   */
  customerId: string;

  /** Build the thing under test. Called once per property, before `reset()`. */
  setup(): Promise<WebhookUnderTest> | WebhookUnderTest;

  /** Optional teardown, called once per property. */
  teardown?(target: WebhookUnderTest): Promise<void> | void;
}

/** A 2xx means "delivered, stop retrying". Anything else means Stripe will try again. */
export const acknowledged = (status: number) => status >= 200 && status < 300;
