import { exampleOptions } from "./adapter";
import { checkThenActHandler, seenIsProcessedHandler, transactionalHandler } from "./handlers";

/** The three example handlers, each with the schema it was written against. */
export const EXAMPLES = {
  transactional: exampleOptions(transactionalHandler, { effectKeyedByInvoice: true }),
  "seen-is-processed": exampleOptions(seenIsProcessedHandler, { effectKeyedByInvoice: false }),
  "check-then-act": exampleOptions(checkThenActHandler, { effectKeyedByInvoice: false }),
};
