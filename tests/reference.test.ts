/**
 * The correct example handler passes every property.
 *
 * This is also what running the suite against your own handler looks like:
 * one call, with options built by your adapter.
 */
import { describeWebhookIdempotency } from "../src/suite";
import { EXAMPLES } from "../examples";

describeWebhookIdempotency("transactional handler (correct)", EXAMPLES.transactional);
