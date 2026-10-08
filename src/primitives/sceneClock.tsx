import React, { createContext, useContext } from "react";
import type { SceneClock } from "./types";

const SceneClockContext = createContext<SceneClock>({
  time: 0,
  frame: 0,
  fps: 30,
  durationSec: 1,
  durationFrames: 30,
});

export const SceneClockProvider = SceneClockContext.Provider;

export const useSceneClock = (): SceneClock => useContext(SceneClockContext);
