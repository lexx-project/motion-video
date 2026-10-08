import colorsJson from "../../design-system/colors.json";
import typographyJson from "../../design-system/typography.json";
import compositionJson from "../../design-system/composition.json";
import motionJson from "../../design-system/motion.json";
import primitivesJson from "../../design-system/primitives.json";
import forbiddenJson from "../../design-system/forbidden-patterns.json";
import mechanismsJson from "../../design-system/mechanisms.json";

export const colors = colorsJson as unknown as {
  background: { base: string; deep: string; elevated: string; hairline: string };
  text: { primary: string; secondary: string; muted: string };
  accents: Record<string, { value: string; dim: string; glow: string; semantic: string }>;
  rules: {
    maxAccentWordsPerHeadline: number;
    oneDominantAccentPerScene: boolean;
    maxGlowsPerScene: number;
    primaryTextContrastMin: number;
  };
};

export const typography = typographyJson as unknown as {
  families: Record<string, { name: string; src: string[]; cssFamily: string; fallback: string }>;
  scale: Record<string, { default: number; min: number; max: number; weight: number; lineHeight: number; letterSpacingEm: number; uppercase: boolean }>;
  rules: { maxHeadlineLines: number; maxHeadlineChars: number; maxAccentWords: number };
};

export const composition = compositionJson as unknown as {
  grammars: string[];
  positions: string[];
  elementPositions: string[];
  safeArea: { marginXPercent: number; marginTopPercent: number; marginBottomPercent: number };
  maxElementsPerScene: number;
  maxSimultaneousMotionSystems: number;
  negativeSpaceRules: { preserveHeadlineBreathingRoomPx: number; minSceneElementCount: number; maxElementsPerScene?: number };
};

export const motion = motionJson as unknown as {
  vocabulary: { entrance: string[]; emphasis: string[]; exit: string[] };
  durations: Record<string, { min: number; default: number; max: number }>;
  easings: Record<string, string>;
  amplitudes: Record<string, { min?: number; default?: number; max?: number; from?: number; to?: number }>;
  rules: Record<string, number | boolean>;
};

export type ParamSpec =
  | { type: "string"; required?: boolean; max?: number; default?: string | number | boolean; optional?: boolean }
  | { type: "number"; required?: boolean; min?: number; max?: number; default?: number; optional?: boolean }
  | { type: "boolean"; required?: boolean; default?: boolean; optional?: boolean }
  | { type: "enum"; values: string[]; required?: boolean; default?: string; optional?: boolean }
  | { type: "stringArray"; required?: boolean; maxItems?: number; minItems?: number; optional?: boolean }
  | {
      type: "objectArray";
      required?: boolean;
      minItems?: number;
      maxItems?: number;
      itemFields: Record<string, ParamSpec>;
      optional?: boolean;
    };

export const primitives = primitivesJson as unknown as {
  common: Record<string, ParamSpec>;
  primitives: Record<string, { category: "typography" | "object" | "diagram" | "atmospheric"; params: Record<string, ParamSpec> }>;
};

export const forbiddenPatterns = forbiddenJson as unknown as {
  patterns: { id: string; label: string; severity: number; rule: string }[];
};

export const mechanisms = mechanismsJson as unknown as {
  mechanisms: string[];
  roles: string[];
  densityGuidelines: Record<string, number[] | string>;
};

export const PRIMITIVE_NAMES = Object.keys(primitives.primitives);
export const isKnownPrimitive = (name: string): boolean => name in primitives.primitives;
