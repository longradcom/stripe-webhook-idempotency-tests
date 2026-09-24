import { describe, it } from "vitest";
import type { SuiteOptions } from "./contract";
import { PROPERTIES, context } from "./properties";

/**
 * Register every property as a Vitest test against your webhook handler.
 *
 *   describeWebhookIdempotency("POST /api/stripe/webhook", { ... });
 *
 * Each property gets a fresh target from `setup()` and a clean state from
 * `reset()`, so one failure cannot cascade into the next.
 */
export function describeWebhookIdempotency(name: string, options: SuiteOptions) {
  describe(name, () => {
    for (const property of PROPERTIES) {
      it(`${property.title} [${property.id}]`, async (t) => {
        const target = await options.setup();
        try {
          if (property.needsFaults && !target.injectFault) {
            t.skip(
              `${property.id} needs injectFault(). It is one of the two properties most likely to ` +
                `find a real bug, so wire it up if you can — see the README.`,
            );
          }
          await target.reset();
          await property.check(context(options, target));
        } finally {
          await options.teardown?.(target);
        }
      });
    }
  });
}
