import type { FaultPoint } from "../src/contract";

/**
 * A one-shot fault switch.
 *
 * The handler calls `faults.hit("after-receipt")` at that point in its work; the
 * test arms it with `faults.arm("after-receipt")`. In production nothing is
 * ever armed and `hit` does nothing. Your own handler can use the same ten
 * lines — see the README.
 */
export class InjectedFault extends Error {}

export function createFaults() {
  let armed: FaultPoint | null = null;
  return {
    arm(point: FaultPoint) {
      armed = point;
    },
    hit(point: FaultPoint) {
      if (armed === point) {
        armed = null;
        throw new InjectedFault(`injected fault at ${point}`);
      }
    },
  };
}

export type Faults = ReturnType<typeof createFaults>;
