/**
 * Each property earns its place by catching a real bug.
 *
 * The two buggy example handlers are run through every property, and the
 * table below says which properties must fail for each. If a property stops
 * failing against the handler it was written to catch, it has stopped testing
 * anything, and this file fails instead.
 */
import { describe, expect, it } from "vitest";
import { PROPERTIES, context } from "../src/properties";
import { EXAMPLES } from "../examples";

const MUST_CATCH: Record<"seen-is-processed" | "check-then-act", string[]> = {
  "seen-is-processed": ["retry-after-failure", "one-effect-per-invoice"],
  "check-then-act": ["crash-after-effect", "concurrent-duplicates", "one-effect-per-invoice"],
};

for (const [name, caught] of Object.entries(MUST_CATCH)) {
  const options = EXAMPLES[name as keyof typeof MUST_CATCH];

  describe(`${name} handler (buggy)`, () => {
    for (const property of PROPERTIES) {
      const expected = caught.includes(property.id) ? "fails" : "passes";

      it(`${property.id} ${expected}`, async () => {
        const target = await options.setup();
        try {
          await target.reset();
          const outcome = await property.check(context(options, target)).then(
            () => "passes",
            () => "fails",
          );
          expect(outcome).toBe(expected);
        } finally {
          await options.teardown?.(target);
        }
      });
    }
  });
}
