import { z } from "zod";

/**
 * VISUAL STORYBOARD contract (Phase 3). Semantic intent is designed BEFORE primitive
 * compilation. Produced by the Visual Storyboard Director, consumed by the Scene Composer,
 * preserved inside Scene JSON (`scene.storyboard`) and inspected by Semantic QA + the UI.
 */

export const storyboardCandidateSchema = z
  .object({
    id: z.string().min(2).max(40),
    visualMechanism: z.string().min(3).max(80),
    concept: z.string().min(5).max(160),
    compositionSketch: z.string().min(5).max(200),
    objects: z.array(z.string().max(50)).min(1).max(8),
    whyDifferent: z.string().min(10).max(240),
    strength: z.string().min(10).max(240),
    complexity: z.enum(["low", "medium", "high"]),
  })
  .strip();

export const storyboardCandidatesSchema = z
  .object({
    beatId: z.string(),
    candidates: z.array(storyboardCandidateSchema).min(3).max(5),
  })
  .strip();

export const storyboardSelectionSchema = z
  .object({
    beatId: z.string(),
    selectedCandidateId: z.string().optional(),
    rejected: z.boolean().optional(),
    rejectionReasons: z.array(z.string().max(240)).max(6).optional(),
    directionForAlternatives: z.string().max(400).optional(),
    semanticMechanism: z.string().max(400).optional(),
    scores: z
      .object({
        semanticRelevance: z.number().min(0).max(10),
        viewerComprehension: z.number().min(0).max(10),
        metaphorStrength: z.number().min(0).max(10),
        visualStorytelling: z.number().min(0).max(10),
        relationshipClarity: z.number().min(0).max(10),
        motionOpportunity: z.number().min(0).max(10),
        typographyHierarchy: z.number().min(0).max(10),
        subtitleIntegration: z.number().min(0).max(10),
        referenceConformance: z.number().min(0).max(10),
        compositionQuality: z.number().min(0).max(10),
        novelty: z.number().min(0).max(10),
        semanticDensity: z.number().min(0).max(10),
        antiSlop: z.number().min(0).max(10),
      })
      .strip(),
    selectionRationale: z.string().min(10).max(900),
  })
  .strip();

export const storyboardSelectionsSchema = z
  .object({ selections: z.array(storyboardSelectionSchema).min(1).max(14) })
  .strip();

const narrativeStep = z
  .object({
    order: z.number().int().min(1).max(12),
    action: z.string().min(3).max(250),
    meaning: z.string().min(3).max(250),
    visualEvidence: z.string().min(3).max(250),
  })
  .strip();

const semanticObject = z
  .object({
    objectType: z.string().min(2).max(60),
    semanticRole: z.string().min(3).max(250),
    relationship: z.string().min(3).max(200),
    importance: z.number().min(1).max(5),
  })
  .strip();

const motionBeat = z
  .object({
    order: z.number().int().min(1).max(12),
    action: z.string().min(3).max(200),
    purpose: z.string().min(3).max(200),
    atSeconds: z.number().min(0).max(60).optional(),
  })
  .strip();

/** Full storyboard (selected + expanded) — the semantic source of truth for one beat. */
export const storyboardSchema = z
  .object({
    beatId: z.string().min(1).max(24),
    spokenMeaning: z.string().min(5).max(400),
    viewerTakeaway: z.string().min(5).max(300),
    visualMechanism: z.string().min(3).max(80),
    visualNarrative: z.array(narrativeStep).min(1).max(8),
    semanticObjects: z.array(semanticObject).min(1).max(10),
    relationships: z
      .array(
        z
          .object({
            from: z.string().min(1).max(60),
            to: z.string().min(1).max(60),
            relationship: z.string().min(2).max(120),
          })
          .strip(),
      )
      .max(8),
    typographyPlan: z
      .object({
        headline: z.string().min(1).max(120),
        emphasisWords: z.array(z.string().max(60)).max(6),
        supportingText: z.array(z.string().max(120)).max(6),
      })
      .strip(),
    subtitlePlan: z
      .object({
        enabled: z.boolean(),
        text: z.string().max(300),
        timing: z.string().max(300),
        role: z.string().max(250),
      })
      .strip(),
    motionBeats: z.array(motionBeat).min(1).max(10),
    compositionIntent: z.string().min(5).max(800),
    visualEvidence: z.array(z.string().min(5).max(300)).min(1).max(8),
    forbiddenInterpretations: z.array(z.string().max(300)).max(8),
    noveltyIntent: z.string().min(5).max(500),
    elementBudget: z
      .object({ min: z.number().int().min(1).max(10), max: z.number().int().min(1).max(10) })
      .strip()
      .refine((b) => b.max >= b.min, { message: "elementBudget.max must be >= min" }),
  })
  .strip();

export type Storyboard = z.infer<typeof storyboardSchema>;
export type StoryboardCandidate = z.infer<typeof storyboardCandidateSchema>;
export type StoryboardCandidates = z.infer<typeof storyboardCandidatesSchema>;
export type StoryboardSelection = z.infer<typeof storyboardSelectionSchema>;
export type StoryboardSelections = z.infer<typeof storyboardSelectionsSchema>;

/** Subtitle band contract: phrase-level timing, VO-synced (Phase 3 §13-14, §37). */
export const subtitleSchema = z
  .object({
    enabled: z.boolean(),
    role: z.string().max(80).default("vo caption"),
    phrases: z
      .array(
        z
          .object({
            text: z.string().min(1).max(160),
            start: z.number().min(0),
            end: z.number().min(0),
            emphasisWords: z.array(z.string().max(40)).max(2).optional(),
          })
          .strip(),
      )
      .max(6),
  })
  .strip();

export type Subtitle = z.infer<typeof subtitleSchema>;
