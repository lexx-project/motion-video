// AUDIT-ONLY frame metrics. Reads PNG/MP4 via ffmpeg -> raw rgb24, prints JSON metrics.
// Usage: node e2e/audit-frames.js <file> [<file>...]
const { execFileSync } = require("child_process");

const W = 540, H = 960;

function decode(file, atSec) {
  const args = ["-hide_banner", "-loglevel", "error"];
  if (atSec != null) args.push("-ss", String(atSec));
  args.push("-i", file, "-frames:v", "1", "-vf", `scale=${W}:${H}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-");
  return execFileSync("ffmpeg", args, { maxBuffer: 1 << 28 });
}

function metrics(buf) {
  const px = W * H;
  let ink = 0, bright = 0, accent = 0;
  let minX = W, maxX = -1, minY = H, maxY = -1;
  const colInk = new Array(W).fill(0);
  const rowInk = new Array(H).fill(0);
  let edgeL = 0, edgeR = 0, edgeT = 0, edgeB = 0;
  const EDGE = 6; // px in 540-wide space => 12px at full res
  let subBandInk = 0, topBandInk = 0;
  const SUB0 = Math.floor(H * 0.755), SUB1 = Math.floor(H * 0.875); // subtitle band ~14.5% bottom
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const r = buf[i], g = buf[i + 1], b = buf[i + 2];
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (L > 55) {
        ink++;
        colInk[x]++; rowInk[y]++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (x < EDGE) edgeL++;
        if (x >= W - EDGE) edgeR++;
        if (y < EDGE) edgeT++;
        if (y >= H - EDGE) edgeB++;
        if (y >= SUB0 && y <= SUB1) subBandInk++;
        if (y >= H * 0.03 && y <= H * 0.35) topBandInk++;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const sat = mx === 0 ? 0 : (mx - mn) / mx;
        if (sat > 0.3 && L > 50 && L < 230) accent++;
      }
      if (L > 140) bright++;
    }
  }
  const pct = (n) => Number((n / px * 100).toFixed(3));
  // right-edge occupancy: is bright content cut by frame edge?
  return {
    inkPct: pct(ink),
    brightPct: pct(bright),
    accentPct: pct(accent),
    bbox: maxX < 0 ? null : { x0: minX, x1: maxX, y0: minY, y1: maxY },
    edgeInk: { left: edgeL, right: edgeR, top: edgeT, bottom: edgeB },
    subBandInkPct: pct(subBandInk),
    topBandInkPct: pct(topBandInk),
    rightColInk: colInk.slice(W - 12).reduce((a, b) => a + b, 0),
    leftColInk: colInk.slice(0, 12).reduce((a, b) => a + b, 0),
    topRowInk: rowInk.slice(0, 12).reduce((a, b) => a + b, 0),
    bottomRowInk: rowInk.slice(H - 12).reduce((a, b) => a + b, 0),
  };
}

const files = process.argv.slice(2);
const out = {};
for (const f of files) {
  try {
    const at = f.includes("mp4") ? Number(process.env.AT ?? 0) : undefined;
    out[f] = metrics(decode(f, Number.isFinite(at) && f.includes("mp4") ? at : undefined));
  } catch (e) {
    out[f] = { error: String(e.message || e).slice(0, 200) };
  }
}
console.log(JSON.stringify(out, null, 1));
