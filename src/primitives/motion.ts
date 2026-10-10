import { Easing, interpolate } from "remotion";
import { motion as motionRules, colors } from "../core/designSystem";
import type { AccentName, SceneClock, SceneMotion } from "./types";

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** CSSProperties.opacity is typed as number | string; we only ever assign numbers. */
export const curOpacity = (s: React.CSSProperties): number =>
  typeof s.opacity === "number" ? s.opacity : 1;

export const easing = {
  entrance: Easing.bezier(0.22, 1, 0.36, 1),
  exit: Easing.bezier(0.4, 0, 1, 1),
  emphasis: Easing.bezier(0.33, 1, 0.68, 1),
  linear: Easing.linear,
};

export const accentColor = (accent: AccentName | string | undefined): string => {
  if (!accent || accent === "none") return colors.text.primary;
  const a = colors.accents[accent];
  return a ? a.value : colors.text.primary;
};

export const accentDim = (accent: AccentName | string | undefined): string => {
  if (!accent || accent === "none") return colors.text.secondary;
  const a = colors.accents[accent];
  return a ? a.dim : colors.text.secondary;
};

export const accentGlow = (accent: AccentName | string | undefined): string => {
  if (!accent || accent === "none") return "rgba(244,241,234,0.2)";
  const a = colors.accents[accent];
  return a ? a.glow : "rgba(244,241,234,0.2)";
};

/** Re-exported from ./sizing so node-side geometry and the render bundle share one definition. */
export { sizeScale } from "./sizing";

export interface MotionInput {
  clock: SceneClock;
  sceneMotion: SceneMotion;
  delay?: number;
  entranceOverride?: string;
  emphasisOverride?: string;
  exitOverride?: string;
  emphasisAtOverride?: number;
  /** accent used for the 'glow' emphasis */
  glowAccent?: string;
  /** skip transform choreography (primitive animates internally) */
  internalMotion?: boolean;
}

const entranceDur = motionRules.durations.entrance.default;
const exitDur = motionRules.durations.exit.default;
const emphasisDur = motionRules.durations.emphasis.default;

/**
 * Deterministic entrance/emphasis/exit styles for one element.
 * Pure function of (scene JSON, frame) - no randomness, no side effects (AGENTS.md rule 5).
 */
export function elementMotionStyle(input: MotionInput): React.CSSProperties {
  const { clock, sceneMotion } = input;
  const t = clock.time;
  const entrance = input.entranceOverride ?? sceneMotion.entrance;
  const exit = input.exitOverride ?? sceneMotion.exit;
  const emphasis = input.emphasisOverride ?? sceneMotion.emphasis;
  const delay = input.delay ?? 0;

  const eProgress = easing.entrance(
    clamp01((t - delay) / Math.max(0.001, entranceDur)),
  );

  const exitStart = clock.durationSec - exitDur;
  const xProgress = easing.exit(clamp01((t - Math.max(exitStart, 0)) / Math.max(0.001, exitDur)));

  const emphasisAt =
    input.emphasisAtOverride ??
    clock.durationSec * 0.45;
  const emProgress = easing.emphasis(
    clamp01((t - emphasisAt) / Math.max(0.001, emphasisDur)),
  );
  const emPulse = Math.sin(emProgress * Math.PI);

  const style: React.CSSProperties = { opacity: 1 };

  if (!input.internalMotion) {
    const slidePx = motionRules.amplitudes.slidePx.default ?? 56;
    const scaleFrom = motionRules.amplitudes.scaleFrom.default ?? 0.97;
    switch (entrance) {
      case "fade":
        style.opacity = eProgress;
        break;
      case "reveal":
        style.opacity = eProgress;
        style.clipPath = `inset(0 0 ${(1 - eProgress) * 100}% 0)`;
        style.transform = `translateY(${(1 - eProgress) * 18}px)`;
        break;
      case "draw":
        style.opacity = eProgress;
        style.clipPath = `inset(0 ${(1 - eProgress) * 100}% 0 0)`;
        break;
      case "slide":
        style.opacity = eProgress;
        style.transform = `translateY(${(1 - eProgress) * slidePx}px)`;
        break;
      case "scale":
        style.opacity = eProgress;
        style.transform = `scale(${scaleFrom + (1 - scaleFrom) * eProgress})`;
        break;
      case "stagger":
      default:
        style.opacity = eProgress;
        break;
    }
  } else {
    style.opacity = Math.min(curOpacity(style), 0.25 + 0.75 * eProgress);
  }

  const parts: string[] = [style.transform ?? ""];

  if (emphasis === "subtleScale" && emPulse > 0) {
    const delta = motionRules.amplitudes.emphasisScaleDelta.default ?? 0.04;
    parts.push(`scale(${1 + delta * emPulse})`);
  } else if (emphasis === "positionShift" && emPulse > 0 && !input.internalMotion) {
    parts.push(`translateY(${-10 * emPulse}px)`);
  } else if (emphasis === "glow" && emPulse > 0) {
    // glow handled by filter below
  }
  if (emphasis === "glow" && emPulse > 0) {
    style.filter = `drop-shadow(0 0 ${18 * emPulse}px ${accentGlow(input.glowAccent ?? "teal")})`;
  }

  if (xProgress > 0) {
    switch (exit) {
      case "fade":
        style.opacity = Math.min(curOpacity(style), 1 - xProgress);
        break;
      case "slide":
        style.opacity = Math.min(curOpacity(style), 1 - xProgress);
        parts.push(`translateY(${-40 * xProgress}px)`);
        break;
      case "dissolve":
        style.opacity = Math.min(curOpacity(style), 1 - xProgress);
        style.filter = `${style.filter ?? ""} blur(${6 * xProgress}px)`.trim();
        break;
      case "maskedTransition":
        parts.push(`translateY(${-8 * xProgress}px)`);
        style.clipPath = `inset(0 0 0 ${xProgress * 100}%)`;
        style.opacity = Math.min(curOpacity(style), 1 - xProgress * 0.6);
        break;
    }
  }

  const joined = parts.filter(Boolean).join(" ");
  if (joined) style.transform = joined;
  return style;
}

export const progressIn = (
  clock: SceneClock,
  startSec: number,
  durationSec: number,
): number =>
  interpolate(clock.time, [startSec, startSec + durationSec], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easing.entrance,
  });
