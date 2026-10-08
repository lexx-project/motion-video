import React from "react";
import { colors, typography } from "../core/designSystem";
import { accentColor, elementMotionStyle, easing, sizeScale } from "./motion";
import type { PrimitiveProps } from "./types";

const bodyFamily = typography.families.body.cssFamily;

/** Text never renders below the caption minimum (design-system typography rules). */
const fs = (base: number, s: number): number => Math.max(typography.scale.label.min, base * s); // never below label min

type ItemState = "todo" | "active" | "done";
interface Item {
  label: string;
  state?: ItemState | string;
}

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

const revealAt = (props: PrimitiveProps, i: number, step = 0.12): number => {
  const start = props.element.delay ?? 0;
  return easing.entrance(Math.min(1, Math.max(0, (props.clock.time - start - i * step) / 0.45)));
};

const stateColor = (state: ItemState | string | undefined, accent: string): string =>
  state === "done" ? colors.text.secondary : state === "active" ? accent : colors.text.muted;

const stateBg = (state: ItemState | string | undefined, accent: string): string =>
  state === "done" ? colors.background.elevated : state === "active" ? accent : colors.background.base;

/* -------------------------------- Timeline -------------------------------- */

export const Timeline: React.FC<PrimitiveProps> = (props) => {
  const p = props.element as unknown as { items: Item[]; orientation?: string };
  const s = sizeScale(props.element.size);
  const accent = accentColor(props.element.accent === "none" ? "teal" : props.element.accent);
  const style = useMotion(props, true);
  const vertical = (p.orientation ?? "vertical") === "vertical";
  return (
    <div
      style={{
        ...style,
        display: "flex",
        flexDirection: vertical ? "column" : "row",
        gap: vertical ? 34 * s : 24 * s,
        alignItems: vertical ? "stretch" : "center",
        fontFamily: bodyFamily,
        maxWidth: vertical ? 760 : 940,
      }}
    >
      {p.items.map((item, i) => {
        const r = revealAt(props, i);
        const st = item.state ?? "todo";
        return (
          <div
            key={i}
            style={{
              display: "flex",
              flexDirection: vertical ? "row" : "column",
              alignItems: vertical ? "center" : "flex-start",
              gap: 20 * s,
              opacity: r,
              transform: `translateY(${(1 - r) * 20}px)`,
              position: "relative",
              ...(vertical ? {} : { flex: 1 }),
            }}
          >
            <div style={{ display: "flex", flexDirection: vertical ? "column" : "row", alignItems: "center", gap: 0 }}>
              <div
                style={{
                  width: 40 * s,
                  height: 40 * s,
                  borderRadius: "50%",
                  background: stateBg(st, accent),
                  border: `3.5px solid ${st === "todo" ? colors.background.hairline : accent}`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: colors.background.deep,
                  fontSize: fs(20, s),
                  fontWeight: 800,
                  flexShrink: 0,
                }}
              >
                {st === "done" ? "✓" : ""}
              </div>
              {i < p.items.length - 1 && vertical ? (
                <div style={{ width: 3.5, height: 44 * s, background: colors.background.hairline }} />
              ) : null}
            </div>
            <span
              style={{
                fontSize: fs(30, s),
                fontWeight: st === "active" ? 800 : 600,
                color: stateColor(st, accent),
                ...(vertical ? {} : { marginTop: 14 * s }),
              }}
            >
              {item.label}
            </span>
            {i < p.items.length - 1 && !vertical ? (
              <div style={{ position: "absolute", left: "72%", right: "-28%", top: 19 * s, height: 3, background: colors.background.hairline }} />
            ) : null}
          </div>
        );
      })}
    </div>
  );
};

/* ------------------------------- Comparison ------------------------------- */

export const Comparison: React.FC<PrimitiveProps> = (props) => {
  const p = props.element as unknown as {
    leftLabel: string;
    rightLabel: string;
    leftItems: string[];
    rightItems: string[];
    accentSide?: string;
  };
  const s = sizeScale(props.element.size);
  const accent = accentColor(props.element.accent === "none" ? "teal" : props.element.accent);
  const style = useMotion(props, true);
  const side = p.accentSide ?? "right";
  const column = (items: string[], label: string, isAccent: boolean, offset: number) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 * s, flex: 1, minWidth: 0 }}>
      <span
        style={{
          fontSize: fs(27, s),
          fontWeight: 800,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: isAccent ? accent : colors.text.muted,
          marginBottom: 6,
        }}
      >
        {label}
      </span>
      {items.map((it, i) => {
        const r = revealAt(props, offset + i);
        return (
          <span
            key={i}
            style={{
              fontSize: fs(28, s),
              fontWeight: isAccent ? 700 : 500,
              color: isAccent ? colors.text.primary : colors.text.secondary,
              background: colors.background.elevated,
              border: `1.5px solid ${isAccent ? accent : colors.background.hairline}`,
              borderRadius: 12 * s,
              padding: `${16 * s}px ${20 * s}px`,
              opacity: r,
              transform: `translateX(${(1 - r) * (isAccent ? 24 : -24)}px)`,
            }}
          >
            {it}
          </span>
        );
      })}
    </div>
  );
  return (
    <div style={{ ...style, display: "flex", gap: 28 * s, alignItems: "flex-start", fontFamily: bodyFamily, width: 900 * s, maxWidth: "100%" }}>
      {column(p.leftItems, p.leftLabel, side === "left", 0)}
      <div style={{ width: 2, alignSelf: "stretch", background: colors.background.hairline, margin: `40px ${8 * s}px 0` }} />
      {column(p.rightItems, p.rightLabel, side === "right", p.leftItems.length)}
    </div>
  );
};

/* -------------------------------- BeforeAfter ------------------------------ */

export const BeforeAfter: React.FC<PrimitiveProps> = (props) => {
  const p = props.element as unknown as {
    beforeLabel: string;
    afterLabel: string;
    beforeItems: string[];
    afterItems: string[];
    direction?: string;
  };
  const s = sizeScale(props.element.size);
  const accent = accentColor(props.element.accent === "none" ? "teal" : props.element.accent);
  const style = useMotion(props, true);
  const horizontal = (p.direction ?? "horizontal") === "horizontal";
  const reveal = revealAt(props, 0);
  return (
    <div
      style={{
        ...style,
        display: "flex",
        flexDirection: horizontal ? "row" : "column",
        gap: 30 * s,
        alignItems: "center",
        fontFamily: bodyFamily,
        maxWidth: 920,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 14 * s, opacity: 0.75 }}>
        <span style={{ fontSize: fs(26, s), fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", color: colors.text.muted }}>
          {p.beforeLabel}
        </span>
        {p.beforeItems.map((it, i) => (
          <span key={i} style={{ fontSize: fs(27, s), fontWeight: 600, color: colors.text.secondary, textDecoration: "line-through", textDecorationColor: colors.background.hairline }}>
            {it}
          </span>
        ))}
      </div>
      <svg width={90 * s} height={60 * s} viewBox="0 0 90 60" style={{ opacity: reveal, transform: horizontal ? `translateX(${(1 - reveal) * -20}px)` : "rotate(90deg)" }}>
        <line x1={4} y1={30} x2={74} y2={30} stroke={accent} strokeWidth={5} strokeLinecap="round" />
        <polyline points="56,12 78,30 56,48" fill="none" stroke={accent} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 * s }}>
        <span style={{ fontSize: fs(26, s), fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", color: accent }}>
          {p.afterLabel}
        </span>
        {p.afterItems.map((it, i) => {
          const r = revealAt(props, i + 1);
          return (
            <span key={i} style={{ fontSize: fs(28, s), fontWeight: 700, color: colors.text.primary, opacity: r, transform: `translateY(${(1 - r) * 14}px)` }}>
              {it}
            </span>
          );
        })}
      </div>
    </div>
  );
};

/* ---------------------------------- Flow ---------------------------------- */

export const Flow: React.FC<PrimitiveProps> = (props) => {
  const p = props.element as unknown as { steps: Item[]; orientation?: string };
  const s = sizeScale(props.element.size);
  const accent = accentColor(props.element.accent === "none" ? "teal" : props.element.accent);
  const style = useMotion(props, true);
  const horizontal = (p.orientation ?? "horizontal") === "horizontal";
  return (
    <div
      style={{
        ...style,
        display: "flex",
        flexDirection: horizontal ? "row" : "column",
        alignItems: "center",
        gap: 18 * s,
        fontFamily: bodyFamily,
        maxWidth: horizontal ? 940 : 700,
        width: horizontal ? "100%" : undefined,
      }}
    >
      {p.steps.map((step, i) => {
        const r = revealAt(props, i, 0.14);
        const st = step.state ?? "todo";
        return (
          <React.Fragment key={i}>
            <div
              style={{
                padding: `${18 * s}px ${26 * s}px`,
                borderRadius: 14 * s,
                background: stateBg(st, accent),
                border: `2.5px solid ${st === "todo" ? colors.background.hairline : accent}`,
                color: st === "active" ? colors.background.deep : st === "done" ? colors.text.secondary : colors.text.muted,
                fontSize: fs(27, s),
                fontWeight: 800,
                opacity: r,
                transform: `translateY(${(1 - r) * 18}px)`,
                whiteSpace: "nowrap",
              }}
            >
              {step.label}
            </div>
            {i < p.steps.length - 1 ? (
              <svg width={horizontal ? 44 * s : 34 * s} height={horizontal ? 24 * s : 40 * s} viewBox={horizontal ? "0 0 44 24" : "0 0 34 40"} style={{ transform: horizontal ? undefined : "rotate(90deg)", opacity: 0.9 }}>
                <line x1={2} y1={12} x2={34} y2={12} stroke={colors.background.hairline} strokeWidth={4} strokeLinecap="round" />
                <polyline points="26,4 38,12 26,20" fill="none" stroke={accent} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : null}
          </React.Fragment>
        );
      })}
    </div>
  );
};

/* --------------------------------- Branch --------------------------------- */

export const Branch: React.FC<PrimitiveProps> = (props) => {
  const p = props.element as unknown as { trunkLabel?: string; branches: Item[] };
  const s = sizeScale(props.element.size);
  const accent = accentColor(props.element.accent === "none" ? "gold" : props.element.accent);
  const style = useMotion(props, true);
  const width = 860 * s;
  const rowH = 110 * s;
  const height = Math.max(200 * s, p.branches.length * rowH);
  return (
    <div style={{ ...style, fontFamily: bodyFamily, position: "relative", width, height }}>
      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
        <path
          d={`M 40 20 L 40 ${height - 30}`}
          stroke={colors.background.hairline}
          strokeWidth={5}
          fill="none"
        />
        {p.branches.map((_, i) => {
          const y = 55 * s + i * rowH;
          const r = revealAt(props, i, 0.16);
          const st = p.branches[i].state ?? "todo";
          return (
            <path
              key={i}
              d={`M 40 ${y - 20 * s} C 40 ${y}, 70 ${y}, 110 ${y}`}
              stroke={st === "todo" ? colors.background.hairline : accent}
              strokeWidth={5}
              fill="none"
              opacity={r}
            />
          );
        })}
      </svg>
      {p.trunkLabel ? (
        <span
          style={{
            position: "absolute",
            left: 70 * s,
            top: -10,
            fontSize: fs(26, s),
            fontWeight: 800,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: colors.text.secondary,
          }}
        >
          {p.trunkLabel}
        </span>
      ) : null}
      {p.branches.map((b, i) => {
        const r = revealAt(props, i, 0.16);
        const st = b.state ?? "todo";
        return (
          <span
            key={i}
            style={{
              position: "absolute",
              left: 130 * s,
              top: 55 * s + i * rowH - 24 * s,
              fontSize: fs(30, s),
              fontWeight: st === "active" ? 800 : 600,
              color: stateColor(st, accent),
              background: colors.background.elevated,
              border: `2px solid ${st === "active" ? accent : colors.background.hairline}`,
              borderRadius: 12 * s,
              padding: `${12 * s}px ${22 * s}px`,
              opacity: r,
              transform: `translateX(${(1 - r) * 24}px)`,
            }}
          >
            {b.label}
          </span>
        );
      })}
    </div>
  );
};

/* ------------------------------ Relationship ------------------------------ */

export const Relationship: React.FC<PrimitiveProps> = (props) => {
  const p = props.element as unknown as { centerLabel: string; nodes: Item[] };
  const s = sizeScale(props.element.size);
  const accent = accentColor(props.element.accent === "none" ? "teal" : props.element.accent);
  const style = useMotion(props, true);
  const size = 760 * s;
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.36;
  return (
    <div style={{ ...style, position: "relative", width: size, height: size, fontFamily: bodyFamily }}>
      <svg width={size} height={size} style={{ position: "absolute", inset: 0 }}>
        {p.nodes.map((_, i) => {
          const a = ((-90 + (360 / p.nodes.length) * i) * Math.PI) / 180;
          const r = revealAt(props, i, 0.13);
          return (
            <line
              key={i}
              x1={cx}
              y1={cy}
              x2={cx + Math.cos(a) * radius * r}
              y2={cy + Math.sin(a) * radius * r}
              stroke={colors.background.hairline}
              strokeWidth={3.5}
            />
          );
        })}
      </svg>
      <div
        style={{
          position: "absolute",
          left: cx,
          top: cy,
          transform: "translate(-50%, -50%)",
          padding: `${22 * s}px ${30 * s}px`,
          borderRadius: 999,
          background: accent,
          color: colors.background.deep,
          fontSize: fs(30, s),
          fontWeight: 900,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          whiteSpace: "nowrap",
        }}
      >
        {p.centerLabel}
      </div>
      {p.nodes.map((n, i) => {
        const a = ((-90 + (360 / p.nodes.length) * i) * Math.PI) / 180;
        const r = revealAt(props, i, 0.13);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: cx + Math.cos(a) * radius,
              top: cy + Math.sin(a) * radius,
              transform: `translate(-50%, -50%) scale(${0.85 + 0.15 * r})`,
              padding: `${14 * s}px ${22 * s}px`,
              borderRadius: 14 * s,
              background: colors.background.elevated,
              border: `2px solid ${n.state === "active" ? accent : colors.background.hairline}`,
              color: n.state === "active" ? accent : colors.text.primary,
              fontSize: fs(25, s),
              fontWeight: 700,
              opacity: r,
              whiteSpace: "nowrap",
            }}
          >
            {n.label}
          </div>
        );
      })}
    </div>
  );
};

/* --------------------------------- Progress -------------------------------- */

export const Progress: React.FC<PrimitiveProps> = (props) => {
  const p = props.element as unknown as { steps: Item[]; orientation?: string };
  const s = sizeScale(props.element.size);
  const accent = accentColor(props.element.accent === "none" ? "teal" : props.element.accent);
  const style = useMotion(props, true);
  const horizontal = (p.orientation ?? "horizontal") !== "vertical";
  return (
    <div
      style={{
        ...style,
        display: "flex",
        flexDirection: horizontal ? "row" : "column",
        gap: 20 * s,
        fontFamily: bodyFamily,
        maxWidth: 940,
        width: horizontal ? "100%" : undefined,
        alignItems: horizontal ? "center" : "stretch",
      }}
    >
      {p.steps.map((step, i) => {
        const r = revealAt(props, i, 0.11);
        const st = step.state ?? "todo";
        const doneCount = p.steps.filter((x) => (x.state ?? "todo") === "done").length;
        return (
          <React.Fragment key={i}>
            <div
              style={{
                flex: horizontal ? 1 : undefined,
                display: "flex",
                alignItems: "center",
                gap: 14 * s,
                opacity: r,
                transform: `translateY(${(1 - r) * 16}px)`,
              }}
            >
              <div
                style={{
                  width: 34 * s,
                  height: 34 * s,
                  borderRadius: "50%",
                  flexShrink: 0,
                  background: st === "todo" ? "transparent" : accent,
                  border: `3px solid ${st === "todo" ? colors.background.hairline : accent}`,
                }}
              />
              <span style={{ fontSize: fs(27, s), fontWeight: st === "active" ? 800 : 600, color: stateColor(st, accent) }}>
                {step.label}
              </span>
            </div>
            {i < p.steps.length - 1 ? (
              <div
                style={{
                  flex: horizontal ? 0.4 : undefined,
                  height: horizontal ? 4 : 2,
                  width: horizontal ? undefined : "100%",
                  marginLeft: horizontal ? -8 * s : 14 * s,
                  background:
                    i < doneCount ? accent : colors.background.hairline,
                  borderRadius: 4,
                }}
              />
            ) : null}
          </React.Fragment>
        );
      })}
    </div>
  );
};

/* -------------------------------- Sequence --------------------------------- */

export const Sequence: React.FC<PrimitiveProps> = (props) => {
  const p = props.element as unknown as { items: Item[]; numbered?: boolean };
  const s = sizeScale(props.element.size);
  const accent = accentColor(props.element.accent === "none" ? "gold" : props.element.accent);
  const style = useMotion(props, true);
  return (
    <div style={{ ...style, display: "flex", flexDirection: "column", gap: 22 * s, fontFamily: bodyFamily, maxWidth: 820 }}>
      {p.items.map((item, i) => {
        const r = revealAt(props, i, 0.15);
        const st = item.state ?? (i === 0 ? "active" : "todo");
        return (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 22 * s, opacity: r, transform: `translateX(${(1 - r) * -28}px)` }}>
            {p.numbered !== false ? (
              <span
                style={{
                  width: 58 * s,
                  height: 58 * s,
                  borderRadius: 16 * s,
                  background: stateBg(st, accent),
                  border: `2.5px solid ${st === "todo" ? colors.background.hairline : accent}`,
                  color: st === "active" ? colors.background.deep : colors.text.secondary,
                  fontSize: fs(28, s),
                  fontWeight: 900,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                {i + 1}
              </span>
            ) : null}
            <span style={{ fontSize: fs(32, s), fontWeight: st === "active" ? 800 : 600, color: stateColor(st, accent) }}>
              {item.label}
            </span>
          </div>
        );
      })}
    </div>
  );
};
