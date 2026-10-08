import React from "react";
import { typography, colors } from "../core/designSystem";
import { accentColor, elementMotionStyle, sizeScale } from "./motion";
import type { PrimitiveProps } from "./types";

const displayFamily = typography.families.display.cssFamily;
const bodyFamily = typography.families.body.cssFamily;

const baseType = (kind: keyof typeof typography.scale, align: string): React.CSSProperties => {
  const s = typography.scale[kind];
  return {
    fontFamily: displayFamily,
    fontSize: s.default,
    fontWeight: s.weight,
    lineHeight: s.lineHeight,
    letterSpacing: `${s.letterSpacingEm}em`,
    textTransform: s.uppercase ? "uppercase" : "none",
    textAlign: align as React.CSSProperties["textAlign"],
    color: colors.text.primary,
    maxWidth: 928,
    width: "100%",
    wordBreak: "normal" as const,
    overflowWrap: "normal" as const,
  };
};

const renderAccented = (
  text: string,
  accentWords: string[] | undefined,
  accent: string,
): React.ReactNode => {
  if (!accentWords || accentWords.length === 0) return text;
  const lowered = accentWords.map((w) => w.toLowerCase());
  return text.split(/(\s+)/).map((token, i) => {
    const clean = token.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    if (clean && lowered.includes(clean)) {
      return (
        <span key={i} style={{ color: accent }}>
          {token}
        </span>
      );
    }
    return <React.Fragment key={i}>{token}</React.Fragment>;
  });
};

export const Headline: React.FC<PrimitiveProps> = ({ element }) => {
  const p = element as unknown as { text: string; accentWords?: string[]; align?: string };
  const accent =
    element.accent && element.accent !== "none" ? accentColor(element.accent) : accentColor("gold");
  return (
    <div style={baseType("headline", p.align ?? "center")}>
      {renderAccented(p.text, p.accentWords, accent)}
    </div>
  );
};

export const Subheadline: React.FC<PrimitiveProps> = ({ element }) => {
  const p = element as unknown as { text: string; accentWords?: string[]; align?: string };
  const accent = accentColor(element.accent === "none" ? "gold" : element.accent);
  return (
    <div style={{ ...baseType("subheadline", p.align ?? "center"), color: colors.text.secondary, fontFamily: bodyFamily }}>
      {renderAccented(p.text, p.accentWords, accent)}
    </div>
  );
};

export const Label: React.FC<PrimitiveProps> = ({ element }) => {
  const p = element as unknown as { text: string; align?: string };
  return (
    <div
      style={{
        ...baseType("label", p.align ?? "center"),
        fontFamily: bodyFamily,
        color: element.accent !== "none" ? accentColor(element.accent) : colors.text.secondary,
      }}
    >
      {p.text}
    </div>
  );
};

export const Caption: React.FC<PrimitiveProps> = ({ element }) => {
  const p = element as unknown as { text: string; align?: string };
  return (
    <div
      style={{
        ...baseType("caption", p.align ?? "center"),
        fontFamily: bodyFamily,
        fontWeight: 400,
        textTransform: "none",
        color: colors.text.secondary,
      }}
    >
      {p.text}
    </div>
  );
};

export const WordReveal: React.FC<PrimitiveProps> = ({ element, sceneMotion, clock }) => {
  const p = element as unknown as {
    text: string;
    accentWords?: string[];
    staggerStep?: number;
    align?: string;
  };
  const accent =
    element.accent && element.accent !== "none" ? accentColor(element.accent) : accentColor("gold");
  const words = p.text.split(/\s+/).filter(Boolean);
  const step = p.staggerStep ?? 0.1;
  const style = elementMotionStyle({
    clock,
    sceneMotion,
    delay: element.delay ?? 0,
    entranceOverride: element.entrance,
    emphasisOverride: element.emphasis,
    exitOverride: element.exit,
    emphasisAtOverride: element.emphasisAt,
    glowAccent: element.accent,
    internalMotion: true,
  });
  return (
    <div style={{ ...baseType("headline", p.align ?? "center"), ...style, display: "flex", flexWrap: "wrap", justifyContent: p.align === "left" ? "flex-start" : p.align === "right" ? "flex-end" : "center", columnGap: "0.28em" }}>
      {words.map((w, i) => {
        const local = Math.min(1, Math.max(0, (clock.time - (element.delay ?? 0) - i * step) / 0.35));
        const e = local * local * (3 - 2 * local);
        const isAccent = p.accentWords?.map((x) => x.toLowerCase()).includes(w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""));
        return (
          <span
            key={i}
            style={{
              opacity: e,
              transform: `translateY(${(1 - e) * 22}px)`,
              color: isAccent ? accent : colors.text.primary,
              display: "inline-block",
            }}
          >
            {w}
          </span>
        );
      })}
    </div>
  );
};

export const CharacterReveal: React.FC<PrimitiveProps> = ({ element, sceneMotion, clock }) => {
  const p = element as unknown as { text: string; staggerStep?: number; align?: string };
  const step = p.staggerStep ?? 0.04;
  const style = elementMotionStyle({
    clock,
    sceneMotion,
    delay: element.delay ?? 0,
    entranceOverride: element.entrance,
    emphasisOverride: element.emphasis,
    exitOverride: element.exit,
    emphasisAtOverride: element.emphasisAt,
    glowAccent: element.accent,
    internalMotion: true,
  });
  return (
    <div style={{ ...baseType("headline", p.align ?? "center"), ...style }}>
      {p.text.split("").map((ch, i) => {
        const local = Math.min(1, Math.max(0, (clock.time - (element.delay ?? 0) - i * step) / 0.3));
        const e = local * local * (3 - 2 * local);
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              opacity: e,
              transform: `translateY(${(1 - e) * 16}px)`,
              whiteSpace: ch === " " ? "pre" : undefined,
              color: element.accent !== "none" && i === 0 ? accentColor(element.accent) : undefined,
            }}
          >
            {ch}
          </span>
        );
      })}
    </div>
  );
};

export const HighlightWord: React.FC<PrimitiveProps> = ({ element, sceneMotion, clock }) => {
  const p = element as unknown as { text: string; word: string; align?: string };
  const accent = accentColor(element.accent === "none" ? "gold" : element.accent);
  const style = elementMotionStyle({
    clock,
    sceneMotion,
    delay: element.delay ?? 0,
    entranceOverride: element.entrance,
    emphasisOverride: element.emphasis,
    exitOverride: element.exit,
    emphasisAtOverride: element.emphasisAt,
    glowAccent: element.accent,
  });
  const emphasisAt = element.emphasisAt ?? clock.durationSec * 0.4;
  const underline = Math.min(1, Math.max(0, (clock.time - emphasisAt) / 0.4));
  const parts = p.text.split(new RegExp(`(${p.word})`, "i"));
  return (
    <div style={{ ...baseType("headline", p.align ?? "center"), ...style, fontFamily: bodyFamily }}>
      {parts.map((part, i) =>
        part.toLowerCase() === p.word.toLowerCase() ? (
          <span key={i} style={{ position: "relative", display: "inline-block", color: accent }}>
            {part}
            <span
              style={{
                position: "absolute",
                left: 0,
                bottom: -6,
                height: 8,
                width: `${underline * 100}%`,
                background: accent,
                borderRadius: 4,
              }}
            />
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </div>
  );
};

const formatCount = (v: number): string => {
  const rounded = Math.round(v);
  return rounded.toLocaleString("en-US");
};

export const CounterText: React.FC<PrimitiveProps> = ({ element, sceneMotion, clock }) => {
  const p = element as unknown as {
    from?: number;
    to: number;
    prefix?: string;
    suffix?: string;
    duration?: number;
    align?: string;
  };
  const from = p.from ?? 0;
  const dur = p.duration ?? 1.6;
  const start = element.delay ?? 0;
  const local = Math.min(1, Math.max(0, (clock.time - start) / dur));
  const e = local * local * (3 - 2 * local);
  const value = from + (p.to - from) * e;
  const style = elementMotionStyle({
    clock,
    sceneMotion,
    delay: element.delay ?? 0,
    entranceOverride: element.entrance,
    emphasisOverride: element.emphasis,
    exitOverride: element.exit,
    emphasisAtOverride: element.emphasisAt,
    glowAccent: element.accent,
    internalMotion: true,
  });
  return (
    <div
      style={{
        ...baseType("counter", p.align ?? "center"),
        ...style,
        fontVariantNumeric: "tabular-nums",
        color: element.accent !== "none" ? accentColor(element.accent) : colors.text.primary,
      }}
    >
      {p.prefix ?? ""}
      {formatCount(value)}
      {p.suffix ?? ""}
    </div>
  );
};

export const Quote: React.FC<PrimitiveProps> = ({ element, sceneMotion, clock }) => {
  const p = element as unknown as { text: string; attribution?: string };
  const accent = accentColor(element.accent === "none" ? "gold" : element.accent);
  const style = elementMotionStyle({
    clock,
    sceneMotion,
    delay: element.delay ?? 0,
    entranceOverride: element.entrance,
    emphasisOverride: element.emphasis,
    exitOverride: element.exit,
    emphasisAtOverride: element.emphasisAt,
    glowAccent: element.accent,
  });
  return (
    <div
      style={{
        ...baseType("quote", "center"),
        ...style,
        maxWidth: 860,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 24,
      }}
    >
      <span style={{ fontSize: 96, lineHeight: 0.5, color: accent, fontFamily: displayFamily }}>“</span>
      <span>{p.text}</span>
      {p.attribution ? (
        <span
          style={{
            fontFamily: bodyFamily,
            fontSize: typography.scale.caption.default,
            fontWeight: 600,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: colors.text.muted,
          }}
        >
          — {p.attribution}
        </span>
      ) : null}
    </div>
  );
};
