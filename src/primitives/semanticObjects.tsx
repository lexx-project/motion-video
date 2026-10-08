import React from "react";
import { colors, typography } from "../core/designSystem";
import { accentColor, elementMotionStyle, sizeScale, easing } from "./motion";
import type { PrimitiveProps } from "./types";

/**
 * Phase 3 semantic primitives: human/communication elements for storytelling
 * (social judgment, people-pleasing, dialogue). Flat-vector per the reference
 * object language: no gradients, uniform geometry, semantic accent usage.
 */

const bodyFamily = typography.families.body.cssFamily;

const fs = (base: number, s: number): number => Math.max(typography.scale.label.min, base * s);

/* ---------------------------------- Person --------------------------------- */

export const Person: React.FC<PrimitiveProps> = (props) => {
  const { element, clock } = props;
  const p = element as unknown as { variant?: string; label?: string };
  const variant = p.variant ?? "stand";
  const s = sizeScale(element.size);
  const color = element.accent === "none" ? colors.text.primary : accentColor(element.accent);
  const style = elementMotionStyle({
    clock,
    sceneMotion: props.sceneMotion,
    delay: element.delay ?? 0,
    entranceOverride: element.entrance,
    emphasisOverride: element.emphasis,
    exitOverride: element.exit,
    emphasisAtOverride: element.emphasisAt,
    glowAccent: element.accent,
  });
  const W = 170 * s;
  const H = 270 * s;
  const loadColor = colors.text.secondary;
  return (
    <div style={{ ...style, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
      <svg width={W} height={H} viewBox="0 0 170 270">
        <g transform={variant === "tired" ? "rotate(-8 85 150)" : undefined}>
          <circle cx={85} cy={46} r={36} fill={color} />
          {variant === "reach" ? (
            <>
              <rect x={45} y={96} width={80} height={150} rx={40} fill={color} />
              <line x1={118} y1={128} x2={152} y2={78} stroke={color} strokeWidth={14} strokeLinecap="round" />
            </>
          ) : variant === "carry" ? (
            <>
              <rect x={45} y={96} width={80} height={150} rx={40} fill={color} />
              <rect x={14} y={116} width={142} height={18} rx={9} fill={loadColor} />
            </>
          ) : (
            <rect x={45} y={96} width={80} height={150} rx={40} fill={color} />
          )}
          {variant === "tired" ? (
            <line x1={128} y1={40} x2={150} y2={26} stroke={loadColor} strokeWidth={8} strokeLinecap="round" />
          ) : null}
        </g>
      </svg>
      {p.label ? (
        <span
          style={{
            fontFamily: bodyFamily,
            fontSize: fs(26, s),
            fontWeight: 700,
            color: colors.text.secondary,
            textAlign: "center",
            maxWidth: 240,
          }}
        >
          {p.label}
        </span>
      ) : null}
    </div>
  );
};

/* ------------------------------- SpeechBubble ------------------------------ */

export const SpeechBubble: React.FC<PrimitiveProps> = (props) => {
  const { element, clock } = props;
  const p = element as unknown as { text?: string; variant?: string; direction?: string };
  const variant = p.variant ?? "speech";
  const direction = p.direction ?? "right";
  const s = sizeScale(element.size);
  const accent = element.accent === "none" ? colors.text.muted : accentColor(element.accent);
  const style = elementMotionStyle({
    clock,
    sceneMotion: props.sceneMotion,
    delay: element.delay ?? 0,
    entranceOverride: element.entrance,
    emphasisOverride: element.emphasis,
    exitOverride: element.exit,
    emphasisAtOverride: element.emphasisAt,
    glowAccent: element.accent,
  });
  const W = 340 * s;
  const bodyH = p.text ? 150 * s : 110 * s;
  const H = (p.text ? 210 : 170) * s;
  const tailX = direction === "right" ? W * 0.68 : W * 0.32;
  return (
    <div style={{ ...style, width: W, height: H, position: "relative" }}>
      <svg width={W} height={H} viewBox={`0 0 340 210`}>
        <rect
          x={6}
          y={6}
          width={328}
          height={(bodyH / s) * (150 / 150)}
          rx={24}
          fill={colors.background.elevated}
          stroke={accent}
          strokeWidth={3}
        />
        {variant === "speech" ? (
          <path
            d={`M ${tailX} ${bodyH - 4} L ${tailX + (direction === "right" ? 34 : -34)} ${bodyH + 42} L ${tailX + (direction === "right" ? -18 : 18)} ${bodyH - 6} Z`}
            fill={colors.background.elevated}
            stroke={accent}
            strokeWidth={3}
          />
        ) : (
          <>
            <circle cx={tailX - 10} cy={bodyH + 18} r={11} fill="none" stroke={accent} strokeWidth={3} />
            <circle cx={tailX - 26} cy={bodyH + 42} r={7} fill="none" stroke={accent} strokeWidth={3} />
          </>
        )}
      </svg>
      {p.text ? (
        <span
          style={{
            position: "absolute",
            left: 26,
            top: 18,
            width: W - 52,
            height: bodyH - 30,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            fontFamily: bodyFamily,
            fontSize: fs(27, s),
            fontWeight: 700,
            lineHeight: 1.25,
            color: colors.text.primary,
            wordBreak: "normal" as const,
          }}
        >
          {p.text}
        </span>
      ) : null}
    </div>
  );
};

export { easing };
