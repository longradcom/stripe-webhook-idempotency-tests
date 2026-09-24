/**
 * See the suite's failure messages against a buggy handler:
 *
 *   npm run demo:seen-is-processed
 *   npm run demo:check-then-act
 *
 * Skipped under plain `npm test`, where these failures are expected and are
 * asserted by catches-known-bugs.test.ts instead.
 */
import { describe } from "vitest";
import { describeWebhookIdempotency } from "../src/suite";
import { EXAMPLES } from "../examples";

const handler = process.env.DEMO_HANDLER as keyof typeof EXAMPLES | undefined;

if (handler && EXAMPLES[handler]) {
  describeWebhookIdempotency(`${handler} handler`, EXAMPLES[handler]);
} else {
  describe.skip("demo (set DEMO_HANDLER to run)", () => {});
}
