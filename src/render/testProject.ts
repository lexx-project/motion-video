import type { SceneSpec } from "../validation/schema";

/**
 * STEP 9 artifact: a hand-authored deterministic test project (not generated,
 * not derived from the reference video). Used as Remotion Studio default props
 * and as the schema/render smoke fixture in tests.
 */
export const testProjectScenes: SceneSpec[] = [
  {
    sceneId: "test_01",
    duration: 3.5,
    purpose: "open with a controlled statement about time",
    visualConcept: "clock_face_drawing_itself",
    composition: "centered",
    headline: { text: "TIME DOES NOT WAIT", accentWords: ["TIME"], align: "center" },
    elements: [
      { primitive: "Clock", position: "bottom", accent: "teal", size: "md", delay: 0.3, entrance: "scale" },
      { primitive: "Label", text: "EVERY MORNING", position: "top", accent: "gold", delay: 0.8 },
    ],
    motion: { entrance: "fade", emphasis: "subtleScale", exit: "fade" },
    timing: { entranceAt: 0, emphasisAt: 1.6 },
  },
  {
    sceneId: "test_02",
    duration: 3.2,
    purpose: "show measurable progress toward a goal",
    visualConcept: "progress_bar_climbing",
    composition: "topTextBottomObject",
    headline: { text: "SMALL STEPS COMPOUND", accentWords: ["COMPOUND"], align: "center" },
    elements: [
      { primitive: "ProgressBar", value: 0.75, label: "MOMENTUM", showValue: true, position: "bottom", accent: "teal", delay: 0.4 },
      { primitive: "GridBackground", opacity: 0.1, position: "center" },
    ],
    motion: { entrance: "reveal", emphasis: "controlledReveal", exit: "slide" },
    timing: { entranceAt: 0, emphasisAt: 1.4 },
  },
  {
    sceneId: "test_03",
    duration: 3.0,
    purpose: "contrast the old pattern with the new one",
    visualConcept: "before_after_split",
    composition: "split",
    elements: [
      {
        primitive: "BeforeAfter",
        beforeLabel: "BEFORE",
        afterLabel: "AFTER",
        beforeItems: ["Reactive", "Drifting"],
        afterItems: ["Deliberate", "Focused"],
        position: "center",
        accent: "teal",
        delay: 0.3,
      },
      { primitive: "Caption", text: "the shift is a decision", position: "bottom", align: "center" },
    ],
    motion: { entrance: "fade", emphasis: "positionShift", exit: "dissolve" },
    timing: { entranceAt: 0, emphasisAt: 1.2 },
  },
];
