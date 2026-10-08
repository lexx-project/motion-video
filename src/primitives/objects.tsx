import React from "react";
import { colors, typography } from "../core/designSystem";
import { accentColor, accentDim, elementMotionStyle, sizeScale, easing } from "./motion";
import type { PrimitiveProps } from "./types";

const bodyFamily = typography.families.body.cssFamily;
const displayFamily = typography.families.display.cssFamily;

/** Text never renders below the caption minimum (design-system typography rules). */
const fs = (base: number, s: number): number => Math.max(typography.scale.label.min, base * s); // never below label min

export const surface: React.CSSProperties = {
  background: colors.background.elevated,
  border: `1.5px solid ${colors.background.hairline}`,
  borderRadius: 20,
};

const useMotion = (props: PrimitiveProps, internalMotion = false): React.CSSProperties =>
  elementMotionStyle({
    clock: props.clock,
    sceneMotion: props.sceneMotion,
    delay: props.element.delay ?? 0,
    entranceOverride: props.element.entrance,
    emphasisOverride: props.element.emphasis,
    exitOverride: props.element.exit,
    emphasisAtOverride: props.element.emphasisAt,
    glowAccent: props.element.accent,
    internalMotion,
  });

const box = (w: number, h: number, scale: number): React.CSSProperties => ({
  width: w * scale,
  height: h * scale,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
});

/* ---------------------------------- Clock --------------------------------- */

export const Clock: React.FC<PrimitiveProps> = (props) => {
  const { element, clock } = props;
  const p = element as unknown as { hour?: number; minute?: number; variant?: string };
  const variant = p.variant ?? "analog";
  const accent = accentColor(element.accent === "none" ? "teal" : element.accent);
  const s = sizeScale(element.size);
  const style = useMotion(props);
  const start = element.delay ?? 0;
  const draw = easing.entrance(Math.min(1, Math.max(0, (clock.time - start) / 1.1)));

  if (variant === "digital") {
    const hh = String(p.hour ?? 9).padStart(2, "0");
    const mm = String(p.minute ?? 15).padStart(2, "0");
    return (
      <div style={{ ...style, ...box(360, 160, s), fontFamily: displayFamily, fontSize: fs(96, s), fontWeight: 900, color: colors.text.primary, letterSpacing: "-0.02em" }}>
        {hh}
        <span style={{ color: accent, opacity: Math.floor(clock.time * 2) % 2 ? 1 : 0.35 }}>:</span>
        {mm}
      </div>
    );
  }

  const size = 380 * s;
  const hourDeg = (((p.hour ?? 9) % 12) + (p.minute ?? 15) / 60) * 30 * draw;
  const minDeg = (p.minute ?? 15) * 6 * draw;
  const r = 170;
  return (
    <div style={{ ...style, ...box(size, size, 1) }}>
      <svg width={size} height={size} viewBox="0 0 380 380">
        <circle cx={190} cy={190} r={r} fill={colors.background.elevated} stroke={colors.background.hairline} strokeWidth={3} />
        {Array.from({ length: 12 }).map((_, i) => {
          const a = (i * 30 * Math.PI) / 180;
          const inner = r - (i % 3 === 0 ? 26 : 16);
          return (
            <line
              key={i}
              x1={190 + Math.sin(a) * inner}
              y1={190 - Math.cos(a) * inner}
              x2={190 + Math.sin(a) * (r - 6)}
              y2={190 - Math.cos(a) * (r - 6)}
              stroke={i % 3 === 0 ? colors.text.secondary : colors.background.hairline}
              strokeWidth={i % 3 === 0 ? 5 : 3}
              strokeLinecap="round"
            />
          );
        })}
        <g transform={`rotate(${hourDeg} 190 190)`}>
          <line x1={190} y1={190} x2={190} y2={95} stroke={colors.text.primary} strokeWidth={12} strokeLinecap="round" />
        </g>
        <g transform={`rotate(${minDeg} 190 190)`}>
          <line x1={190} y1={190} x2={190} y2={55} stroke={accent} strokeWidth={7} strokeLinecap="round" />
        </g>
        <circle cx={190} cy={190} r={10} fill={accent} />
      </svg>
    </div>
  );
};

/* -------------------------------- Calendar -------------------------------- */

export const Calendar: React.FC<PrimitiveProps> = (props) => {
  const { element, clock } = props;
  const p = element as unknown as { label?: string; activeDays?: string[]; variant?: string };
  const s = sizeScale(element.size);
  const accent = accentColor(element.accent === "none" ? "gold" : element.accent);
  const style = useMotion(props);
  const active = new Set(p.activeDays ?? ["3", "4", "5", "11"]);
  const start = element.delay ?? 0;
  const cells = Array.from({ length: 28 });
  return (
    <div
      style={{
        ...style,
        ...surface,
        width: 440 * s,
        padding: `${28 * s}px ${26 * s}px`,
        display: "flex",
        flexDirection: "column",
        gap: 16 * s,
        fontFamily: bodyFamily,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: fs(30, s), fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: colors.text.secondary }}>
          {p.label ?? "Day"}
        </span>
        <span style={{ fontSize: fs(26, s), fontWeight: 600, color: accent }}>
          {p.variant === "streak" ? `${active.size} in a row` : "28 days"}
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 10 * s }}>
        {cells.map((_, i) => {
          const day = String(i + 1);
          const on = active.has(day);
          const reveal = Math.min(1, Math.max(0, (clock.time - start - i * 0.02) / 0.3));
          return (
            <div
              key={i}
              style={{
                width: 44 * s,
                height: 44 * s,
                borderRadius: 10 * s,
                background: on ? accent : colors.background.base,
                border: `1.5px solid ${on ? accent : colors.background.hairline}`,
                opacity: reveal,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: fs(20, s),
                fontWeight: 600,
                color: on ? colors.background.deep : colors.text.muted,
              }}
            >
              {i + 1}
            </div>
          );
        })}
      </div>
    </div>
  );
};

/* ------------------------------ ProfileCard ------------------------------- */

export const ProfileCard: React.FC<PrimitiveProps> = (props) => {
  const p = props.element as unknown as { name: string; role?: string; initials?: string };
  const s = sizeScale(props.element.size);
  const accent = accentColor(props.element.accent === "none" ? "teal" : props.element.accent);
  const style = useMotion(props);
  const initials = p.initials ?? p.name.slice(0, 2).toUpperCase();
  return (
    <div style={{ ...style, ...surface, width: 460 * s, padding: `${30 * s}px`, display: "flex", alignItems: "center", gap: 22 * s, fontFamily: bodyFamily }}>
      <div
        style={{
          width: 96 * s,
          height: 96 * s,
          borderRadius: "50%",
          background: colors.background.base,
          border: `2px solid ${accent}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: fs(36, s),
          fontWeight: 800,
          color: accent,
          flexShrink: 0,
        }}
      >
        {initials}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <span style={{ fontSize: fs(34, s), fontWeight: 800, color: colors.text.primary, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {p.name}
        </span>
        {p.role ? <span style={{ fontSize: fs(24, s), fontWeight: 500, color: colors.text.secondary }}>{p.role}</span> : null}
      </div>
    </div>
  );
};

/* ------------------------------ GenericCard ------------------------------- */

export const GenericCard: React.FC<PrimitiveProps> = (props) => {
  const p = props.element as unknown as { label: string; sublabel?: string; state?: string };
  const s = sizeScale(props.element.size);
  const state = p.state ?? "default";
  const accent = accentColor(props.element.accent === "none" ? "teal" : props.element.accent);
  const style = useMotion(props);
  const border =
    state === "active" ? accent : state === "muted" ? colors.background.hairline : colors.background.hairline;
  return (
    <div
      style={{
        ...style,
        ...surface,
        borderColor: border,
        opacity: state === "muted" ? 0.55 : style.opacity,
        width: 380 * s,
        minHeight: 150 * s,
        padding: `${26 * s}px ${24 * s}px`,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        justifyContent: "center",
        gap: 8,
        fontFamily: bodyFamily,
        position: "relative",
        overflow: "hidden",
      }}
    >
      {state === "active" ? (
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 6, background: accent }} />
      ) : null}
      <span style={{ fontSize: fs(30, s), fontWeight: 800, color: colors.text.primary, textTransform: "uppercase", letterSpacing: "0.02em" }}>
        {p.label}
      </span>
      {p.sublabel ? (
        <span style={{ fontSize: fs(23, s), fontWeight: 500, color: state === "active" ? accent : colors.text.secondary }}>
          {p.sublabel}
        </span>
      ) : null}
      {state === "done" ? (
        <span style={{ fontSize: fs(22, s), fontWeight: 700, color: accent }}>✓ DONE</span>
      ) : null}
    </div>
  );
};

/* --------------------------------- Target --------------------------------- */

export const Target: React.FC<PrimitiveProps> = (props) => {
  const { element, clock } = props;
  const p = element as unknown as { rings?: number; hitIndex?: number; label?: string };
  const s = sizeScale(element.size);
  const accent = accentColor(element.accent === "none" ? "red" : element.accent);
  const style = useMotion(props);
  const rings = p.rings ?? 4;
  const hitIndex = p.hitIndex ?? -1;
  const hasHit = hitIndex >= 0 && hitIndex < rings;
  const size = 400 * s;
  const hitAt = element.emphasisAt ?? clock.durationSec * 0.5;
  const hit = easing.entrance(Math.min(1, Math.max(0, (clock.time - hitAt) / 0.5)));
  return (
    <div style={{ ...style, display: "flex", flexDirection: "column", alignItems: "center", gap: 18 }}>
      <svg width={size} height={size} viewBox="0 0 400 400">
        {Array.from({ length: rings }).map((_, i) => {
          const radius = 170 - i * (140 / Math.max(1, rings - 1));
          const on = hasHit && i === hitIndex;
          return (
            <circle
              key={i}
              cx={200}
              cy={200}
              r={radius}
              fill={i === rings - 1 ? colors.background.elevated : "transparent"}
              stroke={on ? accent : colors.background.hairline}
              strokeWidth={on ? 5 : 3}
            />
          );
        })}
        {hasHit ? (
          <g opacity={hit} transform={`translate(${200 - 14} ${200 - 14}) scale(${0.6 + 0.4 * hit})`}>
            <circle cx={14} cy={14} r={12} fill={accent} />
          </g>
        ) : null}
      </svg>
      {p.label ? (
        <span style={{ fontFamily: bodyFamily, fontSize: fs(26, s), fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: colors.text.secondary }}>
          {p.label}
        </span>
      ) : null}
    </div>
  );
};

/* ------------------------------- ProgressBar ------------------------------ */

export const ProgressBar: React.FC<PrimitiveProps> = (props) => {
  const { element, clock } = props;
  const p = element as unknown as { value: number; label?: string; showValue?: boolean };
  const s = sizeScale(element.size);
  const accent = accentColor(element.accent === "none" ? "teal" : element.accent);
  const style = useMotion(props);
  const start = element.delay ?? 0;
  const fill = easing.entrance(Math.min(1, Math.max(0, (clock.time - start) / 1.0))) * p.value;
  return (
    <div style={{ ...style, width: 560 * s, display: "flex", flexDirection: "column", gap: 14, fontFamily: bodyFamily }}>
      {(p.label || p.showValue) && (
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: fs(26, s), fontWeight: 700 }}>
          <span style={{ color: colors.text.secondary, letterSpacing: "0.06em", textTransform: "uppercase" }}>{p.label ?? ""}</span>
          {p.showValue ? <span style={{ color: accent }}>{Math.round(fill * 100)}%</span> : null}
        </div>
      )}
      <div style={{ height: 22 * s, borderRadius: 999, background: colors.background.elevated, border: `1.5px solid ${colors.background.hairline}`, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${fill * 100}%`, background: accent, borderRadius: 999 }} />
      </div>
    </div>
  );
};

/* -------------------------------- Checkbox -------------------------------- */

export const Checkbox: React.FC<PrimitiveProps> = (props) => {
  const { element, clock } = props;
  const p = element as unknown as { checked?: boolean; label?: string; checkAt?: number };
  const s = sizeScale(element.size);
  const accent = accentColor(element.accent === "none" ? "teal" : element.accent);
  const style = useMotion(props);
  const checkAt = p.checkAt ?? element.emphasisAt ?? clock.durationSec * 0.45;
  const draw = p.checked ? Math.min(1, Math.max(0, (clock.time - checkAt) / 0.4)) : 0;
  const boxSize = 74 * s;
  return (
    <div style={{ ...style, display: "flex", alignItems: "center", gap: 22, fontFamily: bodyFamily }}>
      <div
        style={{
          width: boxSize,
          height: boxSize,
          borderRadius: 16 * s,
          border: `4px solid ${p.checked && draw > 0 ? accent : colors.background.hairline}`,
          background: colors.background.elevated,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg width={boxSize * 0.6} height={boxSize * 0.6} viewBox="0 0 40 40">
          <path
            d="M8 21 L17 30 L32 12"
            fill="none"
            stroke={accent}
            strokeWidth={6}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray={60}
            strokeDashoffset={60 * (1 - draw)}
          />
        </svg>
      </div>
      {p.label ? (
        <span
          style={{
            fontSize: fs(34, s),
            fontWeight: 700,
            color: colors.text.primary,
            textDecoration: draw > 0.9 ? "line-through" : "none",
            textDecorationColor: accent,
          }}
        >
          {p.label}
        </span>
      ) : null}
    </div>
  );
};

/* ---------------------------------- Arrow --------------------------------- */

export const Arrow: React.FC<PrimitiveProps> = (props) => {
  const { element, clock } = props;
  const p = element as unknown as { direction?: string; variant?: string; lengthPct?: number };
  const s = sizeScale(element.size);
  const accent = accentColor(element.accent === "none" ? "gold" : element.accent);
  const style = useMotion(props);
  const start = element.delay ?? 0;
  const draw = easing.entrance(Math.min(1, Math.max(0, (clock.time - start) / 0.7)));
  const len = (p.lengthPct ?? 50) * 5.6 * s;
  const dir = p.direction ?? "right";
  const rotate =
    dir === "left" ? 180 : dir === "up" ? -90 : dir === "down" ? 90 : dir === "diagonal" ? 45 : 0;
  return (
    <div style={{ ...style, transform: `${style.transform ?? ""} rotate(${rotate}deg)`.trim() }}>
      <svg width={len} height={40 * s} viewBox={`0 0 ${len} 40`} style={{ overflow: "visible" }}>
        <line
          x1={0}
          y1={20}
          x2={len * draw - 4}
          y2={20}
          stroke={accent}
          strokeWidth={7}
          strokeLinecap="round"
        />
        <polyline
          points={`${len - 34},2 ${len - 4},20 ${len - 34},38`}
          fill="none"
          stroke={accent}
          strokeWidth={7}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={draw > 0.85 ? (draw - 0.85) / 0.15 : 0}
        />
      </svg>
    </div>
  );
};

/* ---------------------------------- Line ---------------------------------- */

export const Line: React.FC<PrimitiveProps> = (props) => {
  const { element, clock } = props;
  const p = element as unknown as { orientation?: string; lengthPct?: number; thicknessPx?: number };
  const s = sizeScale(element.size);
  // neutral lines must stay visible on the near-black background (reference uses thin but readable strokes)
  const accent = element.accent === "none" ? colors.text.muted : accentColor(element.accent);
  const style = useMotion(props, element.entrance === "draw");
  const horiz = (p.orientation ?? "horizontal") !== "vertical";
  const len = p.lengthPct ?? 60;
  const th = Math.max(3, (p.thicknessPx ?? 4) * s);
  const pixelLen = Math.round((len / 100) * 440 * s);
  const drawProgress = element.entrance === "draw"
    ? easing.entrance(Math.min(1, Math.max(0, (clock.time - (element.delay ?? 0)) / 0.7)))
    : 1;
  return (
    <div
      style={{
        ...style,
        width: horiz ? Math.max(80, pixelLen) : th,
        height: horiz ? th : Math.max(160, pixelLen),
        background: accent,
        borderRadius: th,
        transformOrigin: "left center",
        ...(element.entrance === "draw"
          ? { transform: `${style.transform ?? ""} scaleX(${drawProgress})`.trim() }
          : {}),
      }}
    />
  );
};

/* --------------------------------- Circle --------------------------------- */

export const Circle: React.FC<PrimitiveProps> = (props) => {
  const { element, clock } = props;
  const p = element as unknown as { variant?: string; diameterPct?: number; label?: string };
  const s = sizeScale(element.size);
  const accent = accentColor(element.accent === "none" ? "teal" : element.accent);
  const style = useMotion(props);
  const diameter = (p.diameterPct ?? 40) * 9.2 * s;
  const variant = p.variant ?? "outline";
  const start = element.delay ?? 0;
  const draw = easing.entrance(Math.min(1, Math.max(0, (clock.time - start) / 0.9)));
  const r = 90;
  const circ = 2 * Math.PI * r;
  return (
    <div style={{ ...style, display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
      <svg width={diameter} height={diameter} viewBox="0 0 200 200">
        {variant === "filled" ? (
          <circle cx={100} cy={100} r={92} fill={accent} opacity={draw} />
        ) : variant === "ring" ? (
          <circle
            cx={100}
            cy={100}
            r={r}
            fill="none"
            stroke={accent}
            strokeWidth={20}
            strokeDasharray={circ}
            strokeDashoffset={circ * (1 - draw)}
            transform="rotate(-90 100 100)"
          />
        ) : (
          <circle
            cx={100}
            cy={100}
            r={r}
            fill="transparent"
            stroke={accent}
            strokeWidth={6}
            strokeDasharray={circ}
            strokeDashoffset={circ * (1 - draw)}
            transform="rotate(-90 100 100)"
          />
        )}
      </svg>
      {p.label ? (
        <span style={{ fontFamily: bodyFamily, fontSize: fs(26, s), fontWeight: 700, color: colors.text.secondary, letterSpacing: "0.06em", textTransform: "uppercase" }}>
          {p.label}
        </span>
      ) : null}
    </div>
  );
};

/* --------------------------------- Stack ---------------------------------- */

export const Stack: React.FC<PrimitiveProps> = (props) => {
  const { element, clock } = props;
  const p = element as unknown as { count?: number; variant?: string; label?: string };
  const s = sizeScale(element.size);
  const accent = accentColor(element.accent === "none" ? "teal" : element.accent);
  const style = useMotion(props, true);
  const count = p.count ?? 4;
  const variant = p.variant ?? "cards";
  const start = element.delay ?? 0;
  return (
    <div style={{ ...style, display: "flex", flexDirection: "column", alignItems: "center", gap: 20, fontFamily: bodyFamily }}>
      <div style={{ position: "relative", width: 340 * s, height: (count * 26 + 110) * s }}>
        {Array.from({ length: count }).map((_, i) => {
          const reveal = easing.entrance(
            Math.min(1, Math.max(0, (clock.time - start - i * 0.1) / 0.5)),
          );
          const y = (count - 1 - i) * 26 * s;
          const isTop = i === count - 1;
          return (
            <div
              key={i}
              style={{
                position: "absolute",
                left: 0,
                top: y,
                width: 340 * s,
                height: 92 * s,
                borderRadius: 14 * s,
                background: colors.background.elevated,
                border: `2px solid ${isTop ? accent : colors.background.hairline}`,
                opacity: reveal * (isTop ? 1 : 0.75),
                transform: `translateY(${(1 - reveal) * 30}px)`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                ...(variant === "bars"
                  ? {
                      background: isTop ? accent : colors.background.elevated,
                      width: (340 * (0.5 + (0.5 * (i + 1)) / count)) * s,
                    }
                  : {}),
                ...(variant === "coins" ? { borderRadius: "50%", height: 92 * s } : {}),
              }}
            />
          );
        })}
      </div>
      {p.label ? (
        <span style={{ fontSize: fs(27, s), fontWeight: 700, color: colors.text.secondary, letterSpacing: "0.06em", textTransform: "uppercase" }}>
          {p.label}
        </span>
      ) : null}
    </div>
  );
};

/* ---------------------------------- Grid ---------------------------------- */

export const Grid: React.FC<PrimitiveProps> = (props) => {
  const { element, clock } = props;
  const p = element as unknown as { cols?: number; rows?: number; activeCells?: string[]; variant?: string };
  const s = sizeScale(element.size);
  const accent = accentColor(element.accent === "none" ? "gold" : element.accent);
  const style = useMotion(props, true);
  const cols = p.cols ?? 3;
  const rows = p.rows ?? 3;
  const active = new Set(p.activeCells ?? ["4"]);
  const start = element.delay ?? 0;
  const cell = 92 * s;
  return (
    <div
      style={{
        ...style,
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, ${cell}px)`,
        gap: 14 * s,
      }}
    >
      {Array.from({ length: cols * rows }).map((_, i) => {
        const on = active.has(String(i));
        const reveal = easing.entrance(Math.min(1, Math.max(0, (clock.time - start - i * 0.03) / 0.35)));
        const isDot = p.variant === "dots";
        return (
          <div
            key={i}
            style={{
              width: cell,
              height: cell,
              borderRadius: isDot ? "50%" : 14 * s,
              background: on ? accent : colors.background.elevated,
              border: `2px solid ${on ? accent : colors.background.hairline}`,
              opacity: reveal * (on ? 1 : 0.7),
              transform: `scale(${0.85 + 0.15 * reveal})`,
            }}
          />
        );
      })}
    </div>
  );
};

/* -------------------------------- Indicator -------------------------------- */

export const Indicator: React.FC<PrimitiveProps> = (props) => {
  const { element, clock } = props;
  const p = element as unknown as { variant?: string; label?: string };
  const s = sizeScale(element.size);
  const accent = accentColor(element.accent === "none" ? "teal" : element.accent);
  const style = useMotion(props, p.variant === "pulse");
  const variant = p.variant ?? "dot";
  const pulse = variant === "pulse" ? (Math.sin(clock.time * 3.4 * Math.PI) + 1) / 2 : 0;
  return (
    <div style={{ ...style, display: "flex", alignItems: "center", gap: 18, fontFamily: bodyFamily }}>
      <div style={{ position: "relative", width: 44 * s, height: 44 * s, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {variant === "pulse" ? (
          <span
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: "50%",
              border: `3px solid ${accent}`,
              opacity: 0.65 * (1 - pulse),
              transform: `scale(${1 + pulse * 0.9})`,
            }}
          />
        ) : null}
        <span style={{ width: variant === "arrow" ? 0 : 22 * s, height: variant === "arrow" ? 0 : 22 * s, borderRadius: "50%", background: accent, boxShadow: `0 0 16px ${accentColor(element.accent) === colors.text.primary ? accent : accent}` }} />
        {variant === "arrow" ? (
          <svg width={46 * s} height={46 * s} viewBox="0 0 24 24">
            <path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke={accent} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : null}
      </div>
      {p.label ? <span style={{ fontSize: fs(30, s), fontWeight: 700, color: colors.text.primary }}>{p.label}</span> : null}
    </div>
  );
};

/* --------------------------------- Number --------------------------------- */

export const Number: React.FC<PrimitiveProps> = (props) => {
  const p = props.element as unknown as { value: number; prefix?: string; suffix?: string };
  const s = sizeScale(props.element.size);
  const style = useMotion(props);
  return (
    <div
      style={{
        ...style,
        fontFamily: displayFamily,
        fontSize: fs(170, s),
        fontWeight: 900,
        letterSpacing: "-0.03em",
        color: props.element.accent !== "none" ? accentColor(props.element.accent) : colors.text.primary,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {p.prefix ?? ""}
      {p.value}
      {p.suffix ?? ""}
    </div>
  );
};

/* ---------------------------------- Badge --------------------------------- */

export const Badge: React.FC<PrimitiveProps> = (props) => {
  const p = props.element as unknown as { text: string; variant?: string };
  const s = sizeScale(props.element.size);
  const accent = accentColor(props.element.accent === "none" ? "teal" : props.element.accent);
  const style = useMotion(props);
  const outline = p.variant === "outline";
  return (
    <div
      style={{
        ...style,
        fontFamily: bodyFamily,
        fontSize: fs(28, s),
        fontWeight: 800,
        letterSpacing: "0.1em",
        textTransform: "uppercase",
        padding: `${16 * s}px ${30 * s}px`,
        borderRadius: 999,
        background: outline ? "transparent" : accent,
        border: outline ? `2.5px solid ${accent}` : "none",
        color: outline ? accent : colors.background.deep,
      }}
    >
      {p.text}
    </div>
  );
};

export { accentDim };
