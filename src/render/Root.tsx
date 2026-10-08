import React from "react";
import { Composition } from "remotion";
import { ProjectRenderer, type ProjectVideoProps } from "../scenes/ProjectRenderer";
import { OUTPUT } from "../core/output";
import { testProjectScenes } from "./testProject";

const defaultProps: ProjectVideoProps = {
  scenes: testProjectScenes,
  audioPath: undefined,
};

const totalFrames = (props: ProjectVideoProps): number =>
  Math.max(
    1,
    Math.round(
      props.scenes.reduce(
        (n, s) => n + (typeof s.duration === "number" && !Number.isNaN(s.duration) ? s.duration : 0),
        0,
      ) * OUTPUT.fps,
    ),
  );

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Project"
      component={ProjectRenderer as unknown as React.FC<Record<string, unknown>>}
      durationInFrames={totalFrames(defaultProps)}
      fps={OUTPUT.fps}
      width={OUTPUT.width}
      height={OUTPUT.height}
      defaultProps={defaultProps as unknown as Record<string, unknown>}
      calculateMetadata={({ props }) => ({
        durationInFrames: totalFrames(props as unknown as ProjectVideoProps),
      })}
    />
  );
};
