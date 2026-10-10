import React, { useEffect, useState } from "react";
import {
  AbsoluteFill,
  Audio,
  Sequence,
  continueRender,
  delayRender,
  staticFile,
  useVideoConfig,
} from "remotion";
import { colors, typography } from "../core/designSystem";
import { SceneRenderer } from "./SceneRenderer";
import type { SceneSpec } from "../validation/schema";

const fontFaces = (): string => {
  const rules: string[] = [];
  for (const family of Object.values(typography.families)) {
    for (const src of family.src) {
      const weight = src.includes("-900-")
        ? 900
        : src.includes("-800-")
          ? 800
          : src.includes("-700-")
            ? 700
            : src.includes("-600-")
              ? 600
              : 400;
      rules.push(
        `@font-face{font-family:'${family.name}';src:url('${staticFile(src)}') format('woff2');font-weight:${weight};font-style:normal;font-display:block;}`,
      );
    }
  }
  return rules.join("\n");
};

const FontLoader: React.FC = () => {
  const [handle] = useState(() => delayRender("load-design-system-fonts"));
  const [css] = useState(() => fontFaces());
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        await Promise.all([
          document.fonts.load("900 96px Archivo"),
          document.fonts.load("800 96px Archivo"),
          document.fonts.load("700 52px Archivo"),
          document.fonts.load("400 30px Archivo"),
          document.fonts.load("400 30px Inter"),
          document.fonts.load("600 30px Inter"),
          document.fonts.load("700 30px Inter"),
        ]);
        await document.fonts.ready;
      } catch {
        // font loading failure must not block render forever
      }
      if (!cancelled) continueRender(handle);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [handle]);
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
};

export interface ProjectVideoProps {
  scenes: SceneSpec[];
  /** path relative to public/ (e.g. "proj_123/vo.mp3"); omit for silent render */
  audioPath?: string;
  /**
   * Batch E / Phase 4: isolated-object render (opt-in). Only the element bound to this
   * semanticId paints - used for deterministic per-object pixel evidence.
   */
  isolateSemanticId?: string | null;
}

/**
 * ProjectRenderer: sequences of validated scenes on one timeline + VO audio.
 * Scene boundaries are hard cuts animated by each scene's own exit/entrance.
 */
export const ProjectRenderer: React.FC<ProjectVideoProps> = ({ scenes, audioPath, isolateSemanticId }) => {
  const { fps } = useVideoConfig();
  let cursor = 0;
  const sequences = scenes.map((scene) => {
    const from = cursor;
    const durationInFrames = Math.max(1, Math.round(scene.duration * fps));
    cursor += durationInFrames;
    return { scene, from, durationInFrames };
  });

  return (
    <AbsoluteFill style={{ background: colors.background.deep }}>
      <FontLoader />
      {audioPath ? <Audio src={staticFile(audioPath)} /> : null}
      {sequences.map(({ scene, from, durationInFrames }) => (
        <Sequence key={scene.sceneId} from={from} durationInFrames={durationInFrames} name={scene.sceneId}>
          <SceneRenderer scene={scene} isolate={isolateSemanticId ?? null} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
