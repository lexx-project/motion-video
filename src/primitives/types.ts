import React from "react";
import type { SceneSpec, SceneElement, HeadlineSpec, SceneMotion } from "../validation/schema";

export type AccentName = "none" | "teal" | "gold" | "orange" | "red";

export interface SceneClock {
  /** local time inside the scene, seconds */
  time: number;
  /** local frame inside the scene */
  frame: number;
  fps: number;
  durationSec: number;
  durationFrames: number;
}

export interface PrimitiveProps {
  /** the validated element (flat: primitive + common + specific params) */
  element: SceneElement;
  /** scene-level motion (element may override via element.entrance/emphasis/exit) */
  sceneMotion: SceneMotion;
  clock: SceneClock;
}

export type PrimitiveComponent = React.FC<PrimitiveProps>;

export interface RegistryEntry {
  component: PrimitiveComponent;
  category: "typography" | "object" | "diagram" | "atmospheric";
  /** primitive handles its own entrance choreography (wrapper still applies exit fade) */
  internalMotion?: boolean;
}

export type { SceneSpec, SceneElement, HeadlineSpec, SceneMotion };
