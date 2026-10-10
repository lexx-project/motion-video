// AUDIT-ONLY deep frame probe: region ink, row/col profiles, connected components of tinted pixels.
// Usage: node e2e/audit-probe.js <image> [<image>...]
const { execFileSync } = require("child_process");
const W = 540, H = 960;

function decode(file) {
  return execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-frames:v", "1",
    "-vf", `scale=${W}:${H}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 28 });
}

function probe(file) {
  const buf = decode(file);
  const px = (x, y) => { const i = (y * W + x) * 3; return [buf[i], buf[i + 1], buf[i + 2]]; };
  const luma = (x, y) => { const [r, g, b] = px(x, y); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

  // region ink (luma>55), regions in % coords
  const region = (x0, x1, y0, y1) => {
    let n = 0;
    for (let y = Math.floor(H * y0); y < H * y1; y++)
      for (let x = Math.floor(W * x0); x < W * x1; x++) if (luma(x, y) > 55) n++;
    return +(n / ((x1 - x0) * (y1 - y0) * W * H) * 100).toFixed(3);
  };

  // connected components over "ink" pixels (4-neighbor), report top areas
  const seen = new Uint8Array(W * H);
  const comps = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const idx = y * W + x;
    if (seen[idx] || luma(x, y) <= 55) continue;
    const stack = [[x, y]]; seen[idx] = 1;
    let n = 0, x0 = W, x1 = 0, y0 = H, y1 = 0;
    while (stack.length) {
      const [cx, cy] = stack.pop(); n++;
      if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
      if (cy < y0) y0 = cy; if (cy > y1) y1 = cy;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (!seen[ni] && luma(nx, ny) > 55) { seen[ni] = 1; stack.push([nx, ny]); }
      }
    }
    if (n >= 40) comps.push({ n, x0, x1, y0, y1, w: x1 - x0, h: y1 - y0 });
  }
  comps.sort((a, b) => b.n - a.n);

  // row ink profile compressed into 24 bands; col ink profile into 18 bands
  const rowBands = [], colBands = [];
  for (let b = 0; b < 24; b++) {
    let n = 0;
    for (let y = Math.floor(H * b / 24); y < Math.floor(H * (b + 1) / 24); y++)
      for (let x = 0; x < W; x++) if (luma(x, y) > 55) n++;
    rowBands.push(+(n / (H / 24 * W) * 100).toFixed(2));
  }
  for (let b = 0; b < 18; b++) {
    let n = 0;
    for (let x = Math.floor(W * b / 18); x < Math.floor(W * (b + 1) / 18); x++)
      for (let y = 0; y < H; y++) if (luma(x, y) > 55) n++;
    colBands.push(+(n / (W / 18 * H) * 100).toFixed(2));
  }

  return {
    regions: {
      topBand: region(0, 1, 0.05, 0.35),
      rightMid: region(0.5, 1, 0.35, 0.75),
      leftMid: region(0, 0.5, 0.35, 0.75),
      bottomObj: region(0, 1, 0.55, 0.75),
      subtitle: region(0, 1, 0.755, 0.875),
    },
    components: comps.slice(0, 12),
    componentCount: comps.length,
    rowBands, colBands,
  };
}

const out = {};
for (const f of process.argv.slice(2)) { try { out[f] = probe(f); } catch (e) { out[f] = { error: String(e.message || e).slice(0, 200) }; } }
console.log(JSON.stringify(out));
