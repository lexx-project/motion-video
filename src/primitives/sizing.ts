/**
 * Single definition of the design-system `size` multiplier (sm/md/lg/xl).
 *
 * Lives outside `primitives/motion.ts` so node-side geometry/validation can import it without
 * pulling the Remotion runtime into the tool graph. `motion.ts` re-exports it, so every
 * existing import keeps working and there is exactly one source of truth.
 */
export const sizeScale = (size?: string): number => {
  switch (size) {
    case "sm":
      return 0.7;
    case "lg":
      return 1.35;
    case "xl":
      return 1.8;
    default:
      return 1;
  }
};
