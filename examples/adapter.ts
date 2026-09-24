import type { SuiteOptions, WebhookUnderTest } from "../src/contract";
import { createDb, creditEntries, resetDb } from "./db";
import { createFaults } from "./faults";
import type { HandlerDeps, Handler } from "./handlers";

export const WEBHOOK_SECRET = "whsec_test_reference_handlers";
export const CUSTOMER_ID = "cus_test_1";

/**
 * Suite options for one of the example handlers.
 *
 * This is the whole adapter. Yours will look almost the same: `deliver` calls
 * your route's POST with a Request, `effectCount` queries your database.
 */
export function exampleOptions(
  makeHandler: (deps: HandlerDeps) => Handler,
  schema: { effectKeyedByInvoice: boolean },
): SuiteOptions {
  return {
    webhookSecret: WEBHOOK_SECRET,
    customerId: CUSTOMER_ID,
    async setup(): Promise<WebhookUnderTest & { close(): Promise<void> }> {
      const db = await createDb(schema);
      const faults = createFaults();
      const POST = makeHandler({ db, webhookSecret: WEBHOOK_SECRET, faults });

      return {
        async deliver({ rawBody, signature }) {
          const response = await POST(
            new Request("http://localhost/api/stripe/webhook", {
              method: "POST",
              body: rawBody,
              headers: { "content-type": "application/json", "stripe-signature": signature },
            }),
          );
          return response.status;
        },
        effectCount: (invoiceId) => creditEntries(db, invoiceId),
        injectFault: (point) => faults.arm(point),
        reset: () => resetDb(db, CUSTOMER_ID),
        close: () => db.close(),
      };
    },
    async teardown(target) {
      await (target as WebhookUnderTest & { close(): Promise<void> }).close();
    },
  };
}
