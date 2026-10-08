import { PRIMITIVE_NAMES } from "../core/designSystem";
import { stageError } from "../core/errors";
import type { RegistryEntry } from "./types";
import {
  Headline,
  Subheadline,
  Label,
  Caption,
  WordReveal,
  CharacterReveal,
  HighlightWord,
  CounterText,
  Quote,
} from "./typography";
import {
  Clock,
  Calendar,
  ProfileCard,
  GenericCard,
  Target,
  ProgressBar,
  Checkbox,
  Arrow,
  Line,
  Circle,
  Stack,
  Grid,
  Indicator,
  Number,
  Badge,
} from "./objects";
import {
  Timeline,
  Comparison,
  BeforeAfter,
  Flow,
  Branch,
  Relationship,
  Progress,
  Sequence,
} from "./diagrams";
import {
  GradientGlow,
  SoftOrb,
  Grain,
  GridBackground,
  LightSweep,
} from "./atmospheric";
import { Person, SpeechBubble } from "./semanticObjects";

/**
 * Central primitive registry. Scene JSON references primitives by name;
 * the renderer resolves them here. Unknown names fail - never silently render.
 */
export const primitiveRegistry: Record<string, RegistryEntry> = {
  Headline: { component: Headline, category: "typography" },
  Subheadline: { component: Subheadline, category: "typography" },
  Label: { component: Label, category: "typography" },
  Caption: { component: Caption, category: "typography" },
  WordReveal: { component: WordReveal, category: "typography", internalMotion: true },
  CharacterReveal: { component: CharacterReveal, category: "typography", internalMotion: true },
  HighlightWord: { component: HighlightWord, category: "typography" },
  CounterText: { component: CounterText, category: "typography", internalMotion: true },
  Quote: { component: Quote, category: "typography" },

  Clock: { component: Clock, category: "object" },
  Calendar: { component: Calendar, category: "object" },
  ProfileCard: { component: ProfileCard, category: "object" },
  GenericCard: { component: GenericCard, category: "object" },
  Target: { component: Target, category: "object" },
  ProgressBar: { component: ProgressBar, category: "object" },
  Checkbox: { component: Checkbox, category: "object" },
  Arrow: { component: Arrow, category: "object" },
  Line: { component: Line, category: "object" },
  Circle: { component: Circle, category: "object" },
  Stack: { component: Stack, category: "object" },
  Grid: { component: Grid, category: "object" },
  Indicator: { component: Indicator, category: "object" },
  Number: { component: Number, category: "object" },
  Badge: { component: Badge, category: "object" },
  Person: { component: Person, category: "object" },
  SpeechBubble: { component: SpeechBubble, category: "object" },

  Timeline: { component: Timeline, category: "diagram", internalMotion: true },
  Comparison: { component: Comparison, category: "diagram", internalMotion: true },
  BeforeAfter: { component: BeforeAfter, category: "diagram", internalMotion: true },
  Flow: { component: Flow, category: "diagram", internalMotion: true },
  Branch: { component: Branch, category: "diagram", internalMotion: true },
  Relationship: { component: Relationship, category: "diagram", internalMotion: true },
  Progress: { component: Progress, category: "diagram", internalMotion: true },
  Sequence: { component: Sequence, category: "diagram", internalMotion: true },

  GradientGlow: { component: GradientGlow, category: "atmospheric", internalMotion: true },
  SoftOrb: { component: SoftOrb, category: "atmospheric", internalMotion: true },
  Grain: { component: Grain, category: "atmospheric", internalMotion: true },
  GridBackground: { component: GridBackground, category: "atmospheric", internalMotion: true },
  LightSweep: { component: LightSweep, category: "atmospheric", internalMotion: true },
};

export function resolvePrimitive(name: string): RegistryEntry {
  const entry = primitiveRegistry[name];
  if (!entry) {
    throw stageError("render", `Unknown primitive "${name}". Registered: ${PRIMITIVE_NAMES.join(", ")}`, {
      recoverable: false,
    });
  }
  return entry;
}

/** Every registry entry must have a matching design-system primitive definition (and vice versa). */
export function registryConsistencyErrors(): string[] {
  const errors: string[] = [];
  for (const name of PRIMITIVE_NAMES) {
    if (!(name in primitiveRegistry)) errors.push(`primitives.json defines "${name}" but registry has no component`);
  }
  for (const name of Object.keys(primitiveRegistry)) {
    if (!PRIMITIVE_NAMES.includes(name)) errors.push(`registry has "${name}" but primitives.json does not define it`);
  }
  return errors;
}
