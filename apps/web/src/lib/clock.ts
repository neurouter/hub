/**
 * Injectable wall clock. Range anchors are taken once per URL change (memoized), not per render;
 * tests can stub `clock.now`.
 */
export const clock = {
  now: (): number => Date.now(),
};
