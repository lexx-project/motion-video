import fs from "fs";
import http from "http";
import path from "path";
import { URL } from "url";
import { generateProject, regenerateOneScene } from "../agents/pipeline";
import { rerunQa } from "../agents/pipeline";
import {
  listProjects,
  readManifest,
  updateManifest,
  initProject,
  listScenes,
  readJson,
} from "../core/projectStore";
import { StudioError } from "../core/errors";
import { renderProject } from "../render/renderProject";
import type { SceneSpec } from "../validation/schema";

const PORT = Number(process.env.STUDIO_PORT ?? 8787);
const ROOT = process.cwd();

interface Job {
  projectId: string;
  kind: "generate" | "regenerate-scene" | "render" | "qa";
  running: boolean;
  stage: string;
  detail?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

const jobs = new Map<string, Job>();

const send = (res: http.ServerResponse, status: number, body: unknown): void => {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
};

const readBody = (req: http.IncomingMessage, limit = 60 * 1024 * 1024): Promise<string> =>
  new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

/** Stream files with HTTP Range support so <video> can seek. */
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

function serveFile(req: http.IncomingMessage, res: http.ServerResponse, file: string): void {
  if (!fs.existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }
  const stat = fs.statSync(file);
  const ext = path.extname(file).toLowerCase();
  // HTML must never be octet-stream - browsers would download it instead of rendering
  const type = MIME[ext] ?? "application/octet-stream";
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Accept-Ranges": "bytes" });
    fs.createReadStream(file).pipe(res);
  }
}

const withJob = (projectId: string, kind: Job["kind"], fn: (job: Job) => Promise<void>): void => {
  const existing = jobs.get(projectId);
  if (existing?.running) return;
  const job: Job = {
    projectId,
    kind,
    running: true,
    stage: "starting",
    startedAt: new Date().toISOString(),
  };
  jobs.set(projectId, job);
  fn(job)
    .then(() => {
      job.running = false;
      job.stage = "done";
      job.finishedAt = new Date().toISOString();
    })
    .catch((e) => {
      job.running = false;
      job.stage = "failed";
      job.error = e instanceof StudioError ? e.message : e instanceof Error ? e.message : String(e);
      job.finishedAt = new Date().toISOString();
    });
};

async function handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? "GET";
  const p = url.pathname;

  if (method === "GET" && p === "/api/projects") {
    return send(res, 200, listProjects());
  }

  if (method === "POST" && p === "/api/projects") {
    const body = JSON.parse(await readBody(req)) as { script: string; title?: string };
    if (!body.script || body.script.trim().length < 10) {
      return send(res, 400, { error: "script must be at least 10 characters" });
    }
    const id = `proj_${Date.now().toString(36)}`;
    initProject(id, body.script, body.title);
    return send(res, 201, readManifest(id));
  }

  const projectMatch = /^\/api\/projects\/([^/]+)(\/.*)?$/.exec(p);
  if (projectMatch) {
    const projectId = decodeURIComponent(projectMatch[1]);
    const rest = projectMatch[2] ?? "/";

    try {
      if (rest === "" || rest === "/") {
        if (method === "GET") return send(res, 200, readManifest(projectId));
        if (method === "PATCH") {
          const body = JSON.parse(await readBody(req));
          return send(res, 200, updateManifest(projectId, body));
        }
      }

      if (rest === "/script" && method === "PUT") {
        const body = JSON.parse(await readBody(req)) as { script: string };
        fs.writeFileSync(path.join(ROOT, "projects", projectId, "input", "script.md"), body.script);
        return send(res, 200, { ok: true });
      }

      if (rest === "/voice" && method === "POST") {
        const body = JSON.parse(await readBody(req)) as { name: string; dataBase64: string };
        const ext = path.extname(body.name || ".mp3") || ".mp3";
        const dest = path.join(ROOT, "projects", projectId, "input", `voice${ext}`);
        fs.writeFileSync(dest, Buffer.from(body.dataBase64, "base64"));
        updateManifest(projectId, { hasAudio: true });
        return send(res, 200, { ok: true, file: `voice${ext}` });
      }

      if (rest === "/generate" && method === "POST") {
        const body = (await readBody(req)) as string;
        const opts = body ? (JSON.parse(body) as { script?: string; resume?: boolean }) : {};
        const manifest = readManifest(projectId);
        if (opts.script) {
          fs.writeFileSync(path.join(ROOT, "projects", projectId, "input", "script.md"), opts.script);
        }
        const script = fs.readFileSync(path.join(ROOT, "projects", projectId, "input", "script.md"), "utf8");
        // Auto-resume: if the project already has completed stages (e.g. from a previous
        // 524-interrupted run), reuse them rather than starting from scratch.
        const hasProgress = Object.values(manifest.stages ?? {}).some((s) => s.status === "done");
        const shouldResume = opts.resume !== false && (opts.resume === true || hasProgress);
        void manifest;
        withJob(projectId, "generate", async (job) => {
          await generateProject({
            projectId,
            script,
            title: readManifest(projectId).title,
            resume: shouldResume,
            onProgress: (stage, detail) => {
              job.stage = stage;
              job.detail = detail;
            },
          });
        });
        return send(res, 202, { started: true, resume: shouldResume });
      }

      if (rest === "/status" && method === "GET") {
        const job = jobs.get(projectId);
        return send(res, 200, { manifest: readManifest(projectId), job: job ?? null });
      }

      if (rest === "/scenes" && method === "GET") {
        return send(res, 200, listScenes(projectId).map((s) => ({ sceneId: s.sceneId, scene: s.data })));
      }

      const sceneMatch = /^\/scenes\/([^/]+)$/.exec(rest);
      if (sceneMatch && method === "GET") {
        const scene = readJson<SceneSpec>(projectId, `scenes/${sceneMatch[1]}.json`);
        if (!scene) return send(res, 404, { error: "scene not found" });
        return send(res, 200, scene);
      }
      if (sceneMatch && method === "PUT") {
        const body = JSON.parse(await readBody(req)) as { notes?: string };
        const sceneId = sceneMatch[1];
        withJob(projectId, "regenerate-scene", async (job) => {
          job.stage = "regenerating scene";
          job.detail = sceneId;
          await regenerateOneScene(projectId, sceneId, body.notes ?? "");
          job.stage = "re-rendering preview";
          const scenes = listScenes(projectId).map((s) => s.data as SceneSpec);
          const file = await renderProject({ scenes, outputName: "render-tmp.mp4" });
          const dest = path.join(ROOT, "projects", projectId, "renders", "preview.mp4");
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(file, dest);
        });
        return send(res, 202, { started: true });
      }

      if (rest === "/render" && method === "POST") {
        withJob(projectId, "render", async (job) => {
          job.stage = "rendering";
          const scenes = listScenes(projectId).map((s) => s.data as SceneSpec);
          const pubDir = path.join(ROOT, "public", projectId);
          const audio = fs.existsSync(pubDir)
            ? fs.readdirSync(pubDir).find((f) => /\.(mp3|wav|m4a|ogg|webm)$/i.test(f))
            : undefined;
          const file = await renderProject({
            scenes,
            audioPath: audio ? `${projectId}/${audio}` : undefined,
            outputName: "render-tmp.mp4",
            onProgress: (pr) => {
              job.detail = `${Math.round(pr * 100)}%`;
            },
          });
          const dest = path.join(ROOT, "projects", projectId, "renders", "preview.mp4");
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(file, dest);
          fs.copyFileSync(file, path.join(ROOT, "projects", projectId, "renders", "final.mp4"));
        });
        return send(res, 202, { started: true });
      }

      if (rest === "/qa" && method === "GET") {
        const summary = readJson(projectId, "qa/qa-summary.json");
        const visual = readJson(projectId, "qa/visual-qa.json");
        const slop = readJson(projectId, "qa/slop-qa.json");
        const novelty = readJson(projectId, "qa/novelty.json");
        return send(res, 200, { summary, visual, slop, novelty });
      }

      if (rest === "/qa/rerun" && method === "POST") {
        withJob(projectId, "qa", async (job) => {
          job.stage = "running QA";
          await rerunQa(projectId);
        });
        return send(res, 202, { started: true });
      }

      if (rest === "/memory" && method === "GET") {
        const history = readJson(projectId, "analysis/beats.json");
        return send(res, 200, history ?? {});
      }
    } catch (e) {
      const err = e instanceof StudioError ? e.toJSON() : { message: e instanceof Error ? e.message : String(e) };
      return send(res, 500, err);
    }
    return send(res, 404, { error: `no route: ${method} ${p}` });
  }

  // static: rendered videos
  const renderMatch = /^\/renders\/([^/]+)\/(preview|final)\.mp4$/.exec(p);
  if (renderMatch) {
    return serveFile(req, res, path.join(ROOT, "projects", renderMatch[1], "renders", `${renderMatch[2]}.mp4`));
  }

  const frameMatch = /^\/api\/frames\/([^/]+)\/(.+)$/.exec(p);
  if (frameMatch) {
    return serveFile(req, res, path.join(ROOT, "projects", frameMatch[1], "qa", "frames", frameMatch[2]));
  }

  // static: built UI (dist-ui) when present
  if (method === "GET" && !p.startsWith("/api")) {
    const uiDist = path.join(ROOT, "dist-ui");
    if (fs.existsSync(uiDist)) {
      const rel = p === "/" ? "index.html" : p.slice(1);
      const file = path.join(uiDist, rel);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(req, res, file);
      const index = path.join(uiDist, "index.html");
      if (fs.existsSync(index)) return serveFile(req, res, index);
    }
  }

  send(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  handle(req, res, url).catch((e) => {
    if (!res.headersSent) send(res, 500, { error: e instanceof Error ? e.message : String(e) });
  });
});

server.listen(PORT, () => {
  console.log(`motion design studio api: http://localhost:${PORT}`);
});
