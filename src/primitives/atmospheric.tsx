import React from "react";
import { colors } from "../core/designSystem";
import { accentColor, accentGlow, curOpacity, elementMotionStyle, easing, sizeScale } from "./motion";
import type { PrimitiveProps } from "./types";

const useMotion = (props: PrimitiveProps, internal = false): React.CSSProperties =>
  elementMotionStyle({
    clock: props.clock,
    sceneMotion: props.sceneMotion,
    delay: props.element.delay ?? 0,
    entranceOverride: props.element.entrance,
    emphasisOverride: props.element.emphasis,
    exitOverride: props.element.exit,
    emphasisAtOverride: props.element.emphasisAt,
    glowAccent: props.element.accent,
    internalMotion: internal,
  });

/* ------------------------------ GradientGlow ------------------------------ */

export const GradientGlow: React.FC<PrimitiveProps> = (props) => {
  const p = props.element as unknown as { intensity?: number; diameterPct?: number };
  const accent = accentColor(props.element.accent === "none" ? "teal" : props.element.accent);
  const style = useMotion(props, true);
  const diameter = (p.diameterPct ?? 70) * 15;
  const intensity = p.intensity ?? 0.35;
  const start = props.element.delay ?? 0;
  const fadeIn = easing.entrance(Math.min(1, Math.max(0, (props.clock.time - start) / 1.2)));
  return (
    <div
      style={{
        ...style,
        position: "absolute",
        width: diameter,
        height: diameter,
        borderRadius: "50%",
        background: `radial-gradient(circle, ${accent} 0%, transparent 70%)`,
        opacity: intensity * fadeIn * (curOpacity(style)),
        filter: "blur(40px)",
        pointerEvents: "none",
      }}
    />
  );
};

/* --------------------------------- SoftOrb -------------------------------- */

export const SoftOrb: React.FC<PrimitiveProps> = (props) => {
  const p = props.element as unknown as { intensity?: number; diameterPct?: number; drift?: number };
  const accent = accentColor(props.element.accent === "none" ? "teal" : props.element.accent);
  const style = useMotion(props, true);
  const diameter = (p.diameterPct ?? 50) * 12;
  const intensity = p.intensity ?? 0.25;
  const drift = p.drift ?? 0.2;
  const t = props.clock.time;
  const dx = Math.sin(t * 0.5) * 30 * drift;
  const dy = Math.cos(t * 0.37) * 22 * drift;
  const start = props.element.delay ?? 0;
  const fadeIn = easing.entrance(Math.min(1, Math.max(0, (props.clock.time - start) / 1.4)));
  return (
    <div
      style={{
        ...style,
        position: "absolute",
        width: diameter,
        height: diameter,
        transform: `${style.transform ?? ""} translate(${dx}px, ${dy}px)`,
        borderRadius: "50%",
        background: `radial-gradient(circle at 35% 35%, ${accent} 0%, transparent 72%)`,
        opacity: intensity * fadeIn * (curOpacity(style)),
        filter: "blur(28px)",
        pointerEvents: "none",
      }}
    />
  );
};

/* ---------------------------------- Grain ---------------------------------- */

export const Grain: React.FC<PrimitiveProps> = (props) => {
  const p = props.element as unknown as { opacity?: number };
  const opacity = Math.min(0.12, p.opacity ?? 0.05);
  const style = useMotion(props, true);
  return (
    <div style={{ ...style, position: "fixed", inset: -20, opacity, pointerEvents: "none", mixBlendMode: "overlay" }}>
      <svg width="100%" height="100%">
        <filter id="studio-grain">
          {/* seed is fixed: deterministic render */}
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" seed="7" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#studio-grain)" />
      </svg>
    </div>
  );
};

/* ----------------------------- GridBackground ----------------------------- */

export const GridBackground: React.FC<PrimitiveProps> = (props) => {
  const p = props.element as unknown as { cellPx?: number; opacity?: number };
  const style = useMotion(props, true);
  const cell = p.cellPx ?? 96;
  const opacity = p.opacity ?? 0.12;
  const accent = accentColor(props.element.accent === "none" ? "teal" : props.element.accent);
  return (
    <div
      style={{
        ...style,
        position: "absolute",
        inset: 0,
        opacity,
        backgroundImage: `linear-gradient(${colors.background.hairline} 1.5px, transparent 1.5px), linear-gradient(90deg, ${colors.background.hairline} 1.5px, transparent 1.5px)`,
        backgroundSize: `${cell}px ${cell}px`,
        maskImage: `radial-gradient(circle at 50% 40%, black 0%, transparent 85%)`,
        WebkitMaskImage: `radial-gradient(circle at 50% 40%, black 0%, transparent 85%)`,
        pointerEvents: "none",
        border: "none",
        borderTop: `1.5px solid ${accent}`,
        borderTopWidth: 0,
      }}
    />
  );
};

/* -------------------------------- LightSweep -------------------------------- */

export const LightSweep: React.FC<PrimitiveProps> = (props) => {
  const p = props.element as unknown as { intensity?: number; angleDeg?: number; duration?: number };
  const accent = accentColor(props.element.accent === "none" ? "gold" : props.element.accent);
  const style = useMotion(props, true);
  const duration = p.duration ?? 1.8;
  const start = props.element.delay ?? 0;
  const local = Math.min(1, Math.max(0, (props.clock.time - start) / duration));
  const x = -40 + local * 180;
  const intensity = p.intensity ?? 0.3;
  const angle = p.angleDeg ?? 20;
  return (
    <div style={{ ...style, position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          top: -100,
          bottom: -100,
          left: `${x}%`,
          width: "28%",
          background: `linear-gradient(90deg, transparent, ${accent}, transparent)`,
          opacity: local > 0 && local < 1 ? intensity : 0,
          transform: `rotate(${angle}deg)`,
          filter: "blur(30px)",
        }}
      />
    </div>
  );
};

export { accentGlow, sizeScale };
