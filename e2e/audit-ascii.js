// AUDIT-ONLY ASCII preview of a frame (no image model needed).
// Usage: node e2e/audit-ascii.js <image> [cols=54]
const { execFileSync } = require("child_process");
const file = process.argv[2];
const COLS = Number(process.argv[3] || 54);
const W = COLS;
const H = Math.round(COLS * (1920 / 1080) * 0.5); // char aspect ~2:1
const buf = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-frames:v", "1",
  "-vf", `scale=${W}:${H}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 24 });
let out = "";
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    const r = buf[i], g = buf[i + 1], b = buf[i + 2];
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    let ch;
    if (sat > 0.3 && L > 45) ch = (g >= r && g >= b * 0.9) ? "t" : (r > b && g > b) ? "g" : "r";
    else if (L > 170) ch = "@";
    else if (L > 110) ch = "#";
    else if (L > 70) ch = "+";
    else if (L > 45) ch = ":";
    else if (L > 28) ch = ".";
    else ch = " ";
    out += ch;
  }
  out += "\n";
}
console.log(out);
console.log(`${W}x${H}  t=teal g=gold r=red @=bright #=mid +=dim :=faint .=bg`);
