import { composition } from "../core/designSystem";

export type Position = string;

/** Anchor point of an element group inside the 1080x1920 canvas (% coordinates + translate). */
export const anchor = (position: Position): { left: string; top: string; tx: number; ty: number } => {
  const mx = composition.safeArea.marginXPercent;
  const mt = composition.safeArea.marginTopPercent;
  const mb = 100 - composition.safeArea.marginBottomPercent;
  switch (position) {
    case "left":
      return { left: `${mx}%`, top: "50%", tx: 0, ty: -50 };
    case "right":
      return { left: `${100 - mx}%`, top: "50%", tx: -100, ty: -50 };
    case "top":
      return { left: "50%", top: `${mt}%`, tx: -50, ty: 0 };
    case "bottom":
      return { left: "50%", top: `${mb}%`, tx: -50, ty: -100 };
    case "topLeft":
      return { left: `${mx}%`, top: `${mt}%`, tx: 0, ty: 0 };
    case "topRight":
      return { left: `${100 - mx}%`, top: `${mt}%`, tx: -100, ty: 0 };
    case "bottomLeft":
      return { left: `${mx}%`, top: `${mb}%`, tx: 0, ty: -100 };
    case "bottomRight":
      return { left: `${100 - mx}%`, top: `${mb}%`, tx: -100, ty: -100 };
    default:
      return { left: "50%", top: "50%", tx: -50, ty: -50 };
  }
};

/** Where a scene-level headline sits for a given composition grammar. */
export const headlinePositionFor = (grammar: string): Position => {
  switch (grammar) {
    case "leftTextRightObject":
    case "split":
      return "left";
    case "rightTextLeftObject":
      return "right";
    case "topTextBottomObject":
    case "objectDominant":
    case "dualObject":
      return "top";
    case "bottomTextTopObject":
      return "bottom";
    case "centered":
    case "typographyDominant":
      return "center";
    default:
      return "top";
  }
};

export const FULLSCREEN_ATMOSPHERIC = new Set(["Grain", "GridBackground", "LightSweep"]);

export const maxWidthFor = (position: Position): string => {
  if (position === "left" || position === "right") return "46%";
  if (position === "center" || position === "top" || position === "bottom") return "90%";
  return "70%";
};

/** Available text width in px for an anchor position (mirrors the renderer layout). */
export const availableWidthPx = (position: Position, canvasWidth = 1080): number =>
  (parseFloat(maxWidthFor(position)) / 100) * canvasWidth;

export interface TextBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Greedy word-wrap line count for a text block at a given width. */
export function wrapLines(text: string, fontSize: number, maxWidthPx: number): number {
  const charW = fontSize * 0.70;
  const perLine = Math.max(3, Math.floor(maxWidthPx / charW));
  let lines = 0;
  for (const para of text.split("\n")) {
    const words = para.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines += 1;
      continue;
    }
    let current = 0;
    lines += 1;
    for (const w of words) {
      const wl = w.length;
      if (current === 0) current = wl;
      else if (current + 1 + wl <= perLine) current += 1 + wl;
      else {
        lines += 1;
        current = wl;
      }
    }
  }
  return Math.max(1, lines);
}

/** Horizontal extent + height of a text block at its anchor (no vertical placement). */
export function horizontalTextBoxFor(
  text: string,
  position: Position,
  fontSize: number,
  align: "left" | "center" | "right" = "center",
  lineHeight = 1.2,
  canvas = { w: 1080, h: 1920 },
): { x0: number; x1: number; h: number } {
  const maxWidthPx = (parseFloat(maxWidthFor(position)) / 100) * canvas.w;
  const natural = text.replace(/\s+/g, " ").trim().length * fontSize * 0.70;
  const words = text.split(/\s+/).filter(Boolean);
  const longestWord = words.reduce((m, w) => Math.max(m, w.length * fontSize * 0.70), 0);
  // word-break:normal - a single long word OVERFLOWS its column (observed: 'PENGARUHNYA'
  // spilling into the object column). Box width must reflect that overflow.
  const width = Math.min(
    Math.max(Math.min(maxWidthPx, Math.max(natural, fontSize * 2)), longestWord),
    maxWidthPx * 1.8,
  );
  const lines = wrapLines(text, fontSize, maxWidthPx);
  const height = lines * fontSize * lineHeight;
  const mx = (composition.safeArea.marginXPercent / 100) * canvas.w;
  let x0: number;
  if (position === "left" || position === "topLeft" || position === "bottomLeft") x0 = mx;
  else if (position === "right" || position === "topRight" || position === "bottomRight")
    x0 = canvas.w - mx - width;
  else if (align === "left") x0 = canvas.w / 2 - maxWidthPx / 2;
  else if (align === "right") x0 = canvas.w / 2 + maxWidthPx / 2 - width;
  else x0 = canvas.w / 2 - width / 2;
  return { x0, x1: x0 + width, h: height };
}

/**
 * Estimated px box of a text block as the renderer lays it out (anchor + wrap).
 * Standalone convenience - collision checks use the group-flow model instead.
 */
export function textBoxFor(
  text: string,
  position: Position,
  fontSize: number,
  align: "left" | "center" | "right" = "center",
  lineHeight = 1.1,
  canvas = { w: 1080, h: 1920 },
): TextBox {
  const t = horizontalTextBoxFor(text, position, fontSize, align, lineHeight, canvas);
  const mt = (composition.safeArea.marginTopPercent / 100) * canvas.h;
  const mb = ((100 - composition.safeArea.marginBottomPercent) / 100) * canvas.h;
  let y0: number;
  if (position === "top" || position === "topLeft" || position === "topRight") y0 = mt;
  else if (position === "bottom" || position === "bottomLeft" || position === "bottomRight") y0 = mb - t.h;
  else y0 = canvas.h / 2 - t.h / 2;
  return { x0: t.x0, y0, x1: t.x1, y1: y0 + t.h };
}

export const overlapArea = (a: TextBox, b: TextBox): number => {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
};

export const alignItemsFor = (position: Position): "flex-start" | "flex-end" | "center" => {
  if (position === "left" || position === "topLeft" || position === "bottomLeft") return "flex-start";
  if (position === "right" || position === "topRight" || position === "bottomRight") return "flex-end";
  return "center";
};

export const justifyContentFor = (position: Position): "flex-start" | "flex-end" | "center" => {
  if (position === "top" || position === "topLeft" || position === "topRight") return "flex-start";
  if (position === "bottom" || position === "bottomLeft" || position === "bottomRight") return "flex-end";
  return "center";
};
