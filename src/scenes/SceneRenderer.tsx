import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { colors } from "../core/designSystem";
import { resolvePrimitive } from "../primitives/registry";
import { SceneClockProvider } from "../primitives/sceneClock";
import { sizeScale } from "../primitives/motion";
import { elementExecutionAt, headlineElementFor, type ExecutionState } from "./execution";
import {
  anchor,
  headlinePositionFor,
  FULLSCREEN_ATMOSPHERIC,
  maxWidthFor,
  alignItemsFor,
  justifyContentFor,
} from "./layout";
import type { SceneSpec, SceneElement } from "../validation/schema";

type Position = string;

interface ElementItem {
  element: SceneElement;
  zIndex: number;
  key: string;
  /** index in scene.elements (-1 for the synthetic headline) - binds the execution plan */
  index: number;
}

interface GroupItem {
  position: Position;
  items: ElementItem[];
}

interface Clock {
  time: number;
  frame: number;
  fps: number;
  durationSec: number;
  durationFrames: number;
}

/**
 * Phase 3 subtitle band: VO-synced phrase captions in their own layer (independent
 * timing, editorial styling from design tokens, inside the bottom safe area).
 * Phrase times are injected deterministically from timestamps.json - never invented.
 */
const SubtitleBand: React.FC<{ clock: Clock; subtitle?: { enabled: boolean; phrases: { text: string; start: number; end: number; emphasisWords?: string[] }[] } }> = ({
  clock,
  subtitle,
}) => {
  if (!subtitle?.enabled || subtitle.phrases.length === 0) return null;
  const active = subtitle.phrases.find(
    (p) => clock.time >= p.start - 0.05 && clock.time <= p.end + 0.25,
  );
  if (!active) return null;
  const entry = easingEntrance(Math.min(1, Math.max(0, (clock.time - active.start) / 0.25)));
  const exit = 1 - Math.min(1, Math.max(0, (clock.time - (active.end + 0.1)) / 0.2));
  const opacity = Math.min(entry, exit);
  if (opacity <= 0.01) return null;
  const emphasized = new Set((active.emphasisWords ?? []).map((w) => w.toLowerCase()));
  return (
    <div
      style={{
        position: "absolute",
        left: "8%",
        right: "8%",
        bottom: "14.5%",
        zIndex: 96,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        opacity,
        transform: `translateY(${(1 - entry) * 10}px)`,
        pointerEvents: "none",
      }}
    >
      <span
        style={{
          fontFamily: "Inter, Arial, sans-serif",
          fontSize: 34,
          fontWeight: 600,
          lineHeight: 1.3,
          letterSpacing: "0.01em",
          color: colors.text.primary,
          maxWidth: 900,
          textShadow: "0 2px 10px rgba(5,5,7,0.85)",
        }}
      >
        {active.text.split(/(\s+)/).map((tok, i) => {
          const clean = tok.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
          return emphasized.has(clean) ? (
            <span key={i} style={{ color: colors.accents.gold.value }}>
              {tok}
            </span>
          ) : (
            <React.Fragment key={i}>{tok}</React.Fragment>
          );
        })}
      </span>
    </div>
  );
};

const easingEntrance = (v: number): number => v * v * (3 - 2 * v);

const ElementInner: React.FC<{
  item: ElementItem;
  scene: SceneSpec;
  clock: Clock;
}> = ({ item, scene, clock }) => {
  // Batch D: the execution plan performs the storyboard's motion beats on the WRAPPER
  // (position/scale/rotation/opacity/clip). Primitives keep their own entrance/emphasis
  // motion - the two compose multiplicatively, exactly as src/scenes/state.ts measures.
  const exec: ExecutionState =
    elementExecutionAt(scene, item.index, clock.time);
  // progress events drive the primitive's numeric value channel when it has one
  const el: SceneElement =
    exec.progress !== null && typeof item.element.value === "number"
      ? { ...item.element, value: exec.progress }
      : item.element;
  const entry = resolvePrimitive(el.primitive);
  const Component = entry.component;
  const offsetX = (typeof el.offsetX === "number" ? el.offsetX : 0) + exec.dx;
  const offsetY = (typeof el.offsetY === "number" ? el.offsetY : 0) + exec.dy;
  const rotation = (typeof el.rotation === "number" ? el.rotation : 0) + exec.rotation;
  const scaleParam = typeof el.scale === "number" ? el.scale : 1;
  const sizeMul = sizeScale(el.size as string | undefined);
  const scale = scaleParam * sizeMul * exec.scaleMul;
  const fullscreen = FULLSCREEN_ATMOSPHERIC.has(el.primitive);

  // neutral execution adds NO style (plan-less scenes render byte-identically)
  const execStyle: React.CSSProperties = {};
  if (exec.opacity !== 1) execStyle.opacity = exec.opacity;
  if (exec.reveal < 1) execStyle.clipPath = `inset(0 0 ${Math.round((1 - exec.reveal) * 100)}% 0)`;

  if (fullscreen) {
    return (
      <div style={{ position: "absolute", inset: 0, zIndex: item.zIndex, ...execStyle }}>
        <Component element={el} sceneMotion={scene.motion} clock={clock} />
      </div>
    );
  }

  return (
    <div
      style={{
        transform: `translate(${(offsetX / 100) * 1080}px, ${(offsetY / 100) * 1920}px) rotate(${rotation}deg) scale(${scale})`,
        zIndex: item.zIndex,
        display: "flex",
        maxWidth: "100%",
        ...execStyle,
      }}
    >
      <Component element={el} sceneMotion={scene.motion} clock={clock} />
    </div>
  );
};

/** Anchor group: every element sharing a position stacks inside one flex column/row (collision-free). */
const AnchorGroup: React.FC<{
  group: GroupItem;
  scene: SceneSpec;
  clock: Clock;
}> = ({ group, scene, clock }) => {
  const { left, top, tx, ty } = anchor(group.position);
  const maxZ = Math.max(...group.items.map((i) => i.zIndex));
  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        transform: `translate(${tx}%, ${ty}%)`,
        maxWidth: maxWidthFor(group.position),
        display: "flex",
        flexDirection: "column",
        alignItems: alignItemsFor(group.position),
        justifyContent: justifyContentFor(group.position),
        gap: 44,
        zIndex: maxZ,
      }}
    >
      {group.items.map((item) => (
        <ElementInner key={item.key} item={item} scene={scene} clock={clock} />
      ))}
    </div>
  );
};

export interface SceneRendererProps {
  scene: SceneSpec;
  /**
   * Batch E / Phase 4: opt-in isolated-object mode. When set to a semanticId, ONLY the
   * element bound to that id renders (headline, subtitle band and every other element are
   * hidden). The resulting pixels are attributable to that semantic id BY CONSTRUCTION of
   * the isolation - no segmentation is claimed. Default (null/undefined) renders exactly
   * as before.
   */
  isolate?: string | null;
}

/**
 * Deterministic scene renderer: scene JSON in, pixels out.
 * Elements sharing an anchor stack inside one flex group so typography/objects never overlap.
 * Pure function of (scene, frame) - no randomness, no network (AGENTS.md rule 5).
 */
export const SceneRenderer: React.FC<SceneRendererProps> = ({ scene, isolate }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const durationFrames = Math.max(1, Math.round(scene.duration * fps));
  const clock: Clock = {
    time: frame / fps,
    frame,
    fps,
    durationSec: scene.duration,
    durationFrames,
  };
  const isolated = typeof isolate === "string" && isolate.length > 0;
  const elements = isolated ? scene.elements.filter((el) => el.semanticId === isolate) : scene.elements;

  const headlineElement: SceneElement | null =
    scene.headline && (!isolated || scene.headline.semanticId === isolate)
      ? headlineElementFor(scene)
      : null;

  const all: ElementItem[] = [
    ...elements.map((el, i) => ({
      element: el,
      zIndex: i + 1,
      key: `${el.primitive}-${i}`,
      index: isolated ? scene.elements.indexOf(el) : i,
    })),
    ...(headlineElement
      ? [
          {
            element: headlineElement,
            zIndex: 90,
            key: "scene-headline",
            index: -1,
          },
        ]
      : []),
  ];

  const groups: GroupItem[] = [];
  for (const item of all) {
    const position = (item.element.position as string | undefined) ?? "center";
    const existing = groups.find((g) => g.position === position);
    if (existing) existing.items.push(item);
    else groups.push({ position, items: [item] });
  }

  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(120% 90% at 50% 30%, ${colors.background.base} 0%, ${colors.background.deep} 100%)`,
        overflow: "hidden",
      }}
    >
      <SceneClockProvider value={clock}>
        {groups.map((g) => (
          <AnchorGroup key={g.position} group={g} scene={scene} clock={clock} />
        ))}
        {!isolated && <SubtitleBand clock={clock} subtitle={scene.subtitle} />}
      </SceneClockProvider>
    </AbsoluteFill>
  );
};
