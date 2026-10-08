import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Player } from "@remotion/player";
import { ProjectRenderer } from "../../src/scenes/ProjectRenderer";
import { OUTPUT } from "../../src/core/output";
import type { SceneSpec } from "../../src/validation/schema";

interface Manifest {
  projectId: string;
  title?: string;
  status: string;
  scriptPreview: string;
  hasAudio: boolean;
  timingSource?: string;
  audioDurationSec?: number;
  sceneIds: string[];
  stages: Record<string, { status: string; error?: string }>;
  lastError?: string;
  updatedAt: string;
}

interface Job {
  running: boolean;
  stage: string;
  detail?: string;
  error?: string;
  kind?: string;
}

interface SceneEntry {
  sceneId: string;
  scene: SceneSpec;
}

interface QaBundleSummary {
  summary?: {
    overallQuality: number;
    confidence?: number;
    variance?: number;
    status: string;
    reasons: string[];
    semantic?: {
      overall: {
        semanticRelevance: number;
        visualStorytelling: number;
        evidenceCoverage: number;
        subtitleCoverage: number | null;
        richness: number;
      };
      scenes: {
        sceneId: string;
        semanticRelevance: number;
        visualStorytelling: number;
        evidenceCoverage: number;
        subtitleCoverage: number | null;
        richness: number;
        source: string;
        evidenceGaps: string[];
      }[];
      notes: string[];
    };
  };
  visual?: {
    evaluatorCount?: number;
    scenes: {
      sceneId: string;
      issues: string[];
      scores?: Record<string, number>;
      stats?: { mean: number; median: number; variance: number; confidence: number };
    }[];
  };
  conformance?: { overall: number };
  slop?: { projectSeverity: number; verdict: string; findings: { sceneId: string; type: string; evidence: string; severity: number }[] };
  novelty?: { results: { sceneId: string; similarity: number; verdict: string }[] };
}

const api = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(url, init);
  const json = (await res.json()) as T;
  if (!res.ok) throw new Error(JSON.stringify(json));
  return json;
};

export const App: React.FC = () => {
  const [projects, setProjects] = useState<Manifest[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [script, setScript] = useState("");
  const [title, setTitle] = useState("");
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [scenes, setScenes] = useState<SceneEntry[]>([]);
  const [activeScene, setActiveScene] = useState<string | null>(null);
  const [qa, setQa] = useState<QaBundleSummary>({});
  const [regenNotes, setRegenNotes] = useState("");
  const [previewBust, setPreviewBust] = useState(0);
  const pollRef = useRef<number | null>(null);

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await api<Manifest[]>("/api/projects"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refreshProject = useCallback(async (id: string) => {
    try {
      const st = await api<{ manifest: Manifest; job: Job | null }>(`/api/projects/${id}/status`);
      setManifest(st.manifest);
      setJob(st.job);
      if (!st.job?.running) {
        const sc = await api<SceneEntry[]>(`/api/projects/${id}/scenes`);
        setScenes(sc);
        const q = await api<QaBundleSummary>(`/api/projects/${id}/qa`);
        setQa(q);
      }
    } catch {
      // project may not be ready
    }
  }, []);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    if (!selected) return;
    void refreshProject(selected);
    pollRef.current = window.setInterval(() => void refreshProject(selected), 1800);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [selected, refreshProject]);

  const createAndUpload = async (): Promise<string | null> => {
    if (script.trim().length < 10) {
      setError("Script must be at least 10 characters.");
      return null;
    }
    setBusy(true);
    setError("");
    try {
      const m = await api<Manifest>("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script, title: title || undefined }),
      });
      if (voiceFile) {
        const dataBase64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
          reader.onerror = () => reject(new Error("file read failed"));
          reader.readAsDataURL(voiceFile);
        });
        await api(`/api/projects/${m.projectId}/voice`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: voiceFile.name, dataBase64 }),
        });
      }
      setSelected(m.projectId);
      setManifest(m);
      return m.projectId;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const generate = async (): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      let id = selected;
      if (!id) {
        id = await createAndUpload();
      }
      if (!id) return;
      await api(`/api/projects/${id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Don't force resume=false — the server auto-detects progress and resumes.
        // Explicitly pass resume:true so the UI intent is clear.
        body: JSON.stringify({ resume: selected ? true : false }),
      });
      await refreshProjects();
      await refreshProject(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const regenerateScene = async (): Promise<void> => {
    if (!selected || !activeScene) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/projects/${selected}/scenes/${activeScene}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: regenNotes }),
      });
      setRegenNotes("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const rerender = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    try {
      await api(`/api/projects/${selected}/render`, { method: "POST" });
      setPreviewBust((b) => b + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const rerunQa = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    try {
      await api(`/api/projects/${selected}/qa/rerun`, { method: "POST" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const sceneEntry = useMemo(
    () => scenes.find((s) => s.sceneId === activeScene) ?? scenes[0] ?? null,
    [scenes, activeScene],
  );

  const stageEntries = manifest ? Object.entries(manifest.stages) : [];
  const jobRunning = Boolean(job?.running);

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>Motion Studio</h1>
        <div>
          <h2>Script</h2>
          <input
            type="text"
            placeholder="Title (optional)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <div style={{ height: 8 }} />
          <textarea
            rows={10}
            placeholder="Paste your script... (WHAT should be communicated)"
            value={script}
            onChange={(e) => setScript(e.target.value)}
          />
        </div>
        <div>
          <h2>VO / Audio</h2>
          <input
            type="file"
            accept="audio/*"
            onChange={(e) => setVoiceFile(e.target.files?.[0] ?? null)}
          />
          <div className="muted">
            {voiceFile ? voiceFile.name : "optional — phrase-level timing fallback without VO"}
          </div>
        </div>
        <div className="row">
          <button onClick={() => void generate()} disabled={busy || jobRunning}>
            {jobRunning ? "Generating…" : selected ? "▶ Resume / Generate" : "Generate video"}
          </button>
          {!selected && (
            <button className="secondary" onClick={() => void createAndUpload()} disabled={busy}>
              Save only
            </button>
          )}
        </div>
        {error ? (
          <div className="error">
            {error}
            {error.includes("524") || error.includes("timeout") ? (
              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
                💡 Proxy timeout — hit <strong>Resume / Generate</strong> to continue from where it stopped.
              </div>
            ) : null}
          </div>
        ) : null}

        <div>
          <h2>Projects</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {projects.map((p) => (
              <div
                key={p.projectId}
                className={`project-item ${selected === p.projectId ? "active" : ""}`}
                onClick={() => {
                  setSelected(p.projectId);
                  setActiveScene(null);
                  setScenes([]);
                }}
              >
                <div className="title">{p.title || p.projectId}</div>
                <div className="row" style={{ marginTop: 4 }}>
                  <span className={`pill ${p.status}`}>{p.status}</span>
                  <span className="id">{p.sceneIds.length} scenes</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </aside>

      <main className="main">
        {!manifest ? (
          <div className="muted">Create a project to begin. Script decides WHAT — the design bible decides HOW it looks.</div>
        ) : (
          <>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h1 style={{ fontSize: 26 }}>{manifest.title || manifest.projectId}</h1>
              <span className={`pill ${manifest.status}`}>{manifest.status}</span>
            </div>

            {jobRunning ? (
              <div className="qa-summary" style={{ marginTop: 12 }}>
                <strong>{job?.stage}</strong> {job?.detail ? <span className="muted">— {job.detail}</span> : null}
                {manifest.stages && Object.values(manifest.stages).some((s) => s.status === "done") ? (
                  <span className="pill complete" style={{ marginLeft: 10, fontSize: 11 }}>↩ resuming from checkpoint</span>
                ) : null}
              </div>
            ) : null}
            {job?.error ? <div className="error" style={{ marginTop: 8 }}>{job.error}</div> : null}
            {manifest.lastError ? <div className="error" style={{ marginTop: 8 }}>{manifest.lastError}</div> : null}

            <h2>Pipeline stages</h2>
            <ul className="stage-list">
              {stageEntries.length === 0 ? <li className="muted">no stages yet</li> : null}
              {stageEntries.map(([name, st]) => (
                <li key={name}>
                  <span>{name}</span>
                  <span className={`st-${st.status}`}>
                    {st.status}
                    {st.error ? ` — ${st.error.slice(0, 120)}` : ""}
                  </span>
                </li>
              ))}
            </ul>

            {manifest.timingSource ? (
              <div className="muted" style={{ marginTop: 6 }}>
                timing source: {manifest.timingSource} · audio: {manifest.hasAudio ? "yes" : "none"}
                {manifest.audioDurationSec ? ` · ${manifest.audioDurationSec.toFixed(1)}s` : ""}
              </div>
            ) : null}

            {scenes.length > 0 ? (
              <>
                <h2>Scenes ({scenes.length})</h2>
                <div className="scenes">
                  {scenes.map((s) => (
                    <div
                      key={s.sceneId}
                      className={`scene-card ${sceneEntry?.sceneId === s.sceneId ? "active" : ""}`}
                      onClick={() => setActiveScene(s.sceneId)}
                    >
                      <div className="sid">{s.sceneId}</div>
                      <div className="concept">{s.scene.visualConcept}</div>
                      <div className="meta">
                        {s.scene.composition} · {s.scene.duration}s · {s.scene.elements.length + (s.scene.headline ? 1 : 0)} elements
                      </div>
                    </div>
                  ))}
                </div>

                <div className="preview-row">
                  <div>
                    <h2>Scene preview</h2>
                    {sceneEntry ? (
                      <div className="player-shell">
                        <Player
                          component={ProjectRenderer as unknown as React.ComponentType<Record<string, unknown>>}
                          inputProps={{ scenes: [sceneEntry.scene] }}
                          durationInFrames={Math.max(1, Math.round(sceneEntry.scene.duration * OUTPUT.fps))}
                          fps={OUTPUT.fps}
                          compositionWidth={OUTPUT.width}
                          compositionHeight={OUTPUT.height}
                          style={{ width: 270, height: 480 }}
                          controls
                          loop
                        />
                      </div>
                    ) : null}
                    <div style={{ marginTop: 10, width: 270 }}>
                      <textarea
                        rows={3}
                        placeholder="Regeneration notes for this scene (optional)"
                        value={regenNotes}
                        onChange={(e) => setRegenNotes(e.target.value)}
                      />
                      <div className="row" style={{ marginTop: 6 }}>
                        <button className="small gold" onClick={() => void regenerateScene()} disabled={busy || jobRunning || !sceneEntry}>
                          Regenerate scene
                        </button>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h2>Rendered preview</h2>
                    <video
                      key={previewBust}
                      className="full"
                      src={`/renders/${manifest.projectId}/preview.mp4?t=${previewBust}`}
                      controls
                      style={{ width: 300 }}
                    />
                    <div className="row" style={{ marginTop: 10 }}>
                      <button className="small" onClick={() => void rerender()} disabled={busy || jobRunning}>
                        Re-render
                      </button>
                      <button className="small secondary" onClick={() => void rerunQa()} disabled={busy || jobRunning}>
                        Re-run QA
                      </button>
                      <a href={`/renders/${manifest.projectId}/final.mp4`} download>
                        <button className="small secondary" disabled={manifest.status !== "complete"}>
                          Download final
                        </button>
                      </a>
                    </div>
                  </div>
                </div>
              </>
            ) : null}

            {sceneEntry ? (
              <>
                <h2>Scene intelligence — {sceneEntry.sceneId}</h2>
                <div className="qa-summary">
                  {sceneEntry.scene.storyboard ? (
                    <>
                      <div className="row" style={{ gap: 8 }}>
                        <span className="pill complete">{sceneEntry.scene.storyboard.visualMechanism}</span>
                        <span className="muted">beat {sceneEntry.scene.storyboard.beatId} · budget {sceneEntry.scene.storyboard.elementBudget.min}-{sceneEntry.scene.storyboard.elementBudget.max}</span>
                      </div>
                      <p style={{ margin: "8px 0 0" }}>
                        <strong>Takeaway:</strong> {sceneEntry.scene.storyboard.viewerTakeaway}
                      </p>
                      <p className="muted" style={{ margin: "4px 0 0" }}>
                        <strong>Said:</strong> {sceneEntry.scene.storyboard.spokenMeaning}
                      </p>
                      <div style={{ marginTop: 8 }}>
                        <strong>Narrative:</strong>
                        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                          {sceneEntry.scene.storyboard.visualNarrative.map((n) => (
                            <li key={n.order}>
                              {n.order}. {n.action} — <em>{n.meaning}</em> <span className="muted">({n.visualEvidence})</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div style={{ marginTop: 6 }}>
                        <strong>Semantic objects:</strong>{" "}
                        {sceneEntry.scene.storyboard.semanticObjects
                          .map((o) => `${o.objectType} [${o.semanticRole}] — ${o.relationship}`)
                          .join(" · ")}
                      </div>
                      {sceneEntry.scene.storyboard.relationships.length > 0 ? (
                        <div style={{ marginTop: 6 }}>
                          <strong>Relationships:</strong>{" "}
                          {sceneEntry.scene.storyboard.relationships.map((r) => `${r.from} → ${r.to} (${r.relationship})`).join(" · ")}
                        </div>
                      ) : null}
                      <div style={{ marginTop: 6 }}>
                        <strong>Motion beats:</strong>{" "}
                        {sceneEntry.scene.storyboard.motionBeats.map((m) => `${m.order}. ${m.action} (${m.purpose})`).join(" · ")}
                      </div>
                      <div className="muted" style={{ marginTop: 6 }}>
                        <strong>Composition intent:</strong> {sceneEntry.scene.storyboard.compositionIntent} ·{" "}
                        <strong>Novelty:</strong> {sceneEntry.scene.storyboard.noveltyIntent}
                      </div>
                    </>
                  ) : (
                    <div className="muted">No storyboard metadata (pre-Phase-3 scene or regeneration without storyboard).</div>
                  )}

                  <div style={{ marginTop: 10 }}>
                    <strong>Subtitle (VO):</strong>{" "}
                    {sceneEntry.scene.subtitle?.enabled && sceneEntry.scene.subtitle.phrases.length > 0 ? (
                      sceneEntry.scene.subtitle.phrases.map((p, i) => (
                        <span key={i} className="muted">
                          [{p.start.toFixed(1)}–{p.end.toFixed(1)}s] “{p.text}”{" "}
                        </span>
                      ))
                    ) : (
                      <span className="muted">disabled / no VO window</span>
                    )}
                  </div>

                  <div style={{ marginTop: 10 }}>
                    <strong>Element roles:</strong>{" "}
                    {sceneEntry.scene.elements
                      .map((e) => `${e.primitive}${e.role ? `(${e.role}${e.purpose ? `: ${e.purpose}` : ""})` : "(no role)"}`)
                      .join(" · ")}
                  </div>

                  {(() => {
                    const v = qa.visual?.scenes.find((s) => s.sceneId === sceneEntry.sceneId);
                    const sem = qa.summary?.semantic?.scenes.find((s) => s.sceneId === sceneEntry.sceneId);
                    const n = qa.novelty?.results.find((r) => r.sceneId === sceneEntry.sceneId);
                    if (!v && !sem) return null;
                    return (
                      <div style={{ marginTop: 10 }}>
                        <strong>QA:</strong>{" "}
                        {v
                          ? `vision rel ${v.scores?.scriptRelevance ?? "-"} clar ${v.scores?.visualClarity ?? "-"} (med ${v.stats?.median ?? "-"}, conf ${v.stats?.confidence ?? "-"})`
                          : ""}
                        {sem
                          ? ` · semantic rel ${sem.semanticRelevance} story ${sem.visualStorytelling} coverage ${sem.evidenceCoverage} richness ${sem.richness} sub ${sem.subtitleCoverage ?? "n/a"}`
                          : ""}
                        {n ? ` · novelty ${n.similarity}% ${n.verdict}` : ""}
                        {v && v.issues.length > 0 ? (
                          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                            {v.issues.map((i, k) => (
                              <li key={k}>{i}</li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    );
                  })()}
                </div>
              </>
            ) : null}

            {qa.summary ? (
              <>
                <h2>QA</h2>
                <div className="qa-summary">
                  <span className="score">{qa.summary.overallQuality.toFixed(1)}</span>
                  <span className={`pill ${qa.summary.status === "pass" ? "complete" : "failed"}`} style={{ marginLeft: 10 }}>
                    {qa.summary.status}
                  </span>
                  {qa.summary.confidence !== undefined ? (
                    <span className="muted" style={{ marginLeft: 10 }}>
                      judge confidence {qa.summary.confidence.toFixed(2)} · variance {qa.summary.variance?.toFixed(2)}
                      {qa.visual?.evaluatorCount ? ` · ${qa.visual.evaluatorCount} evaluators (median)` : ""}
                    </span>
                  ) : null}
                  {qa.conformance ? (
                    <div className="muted" style={{ marginTop: 4 }}>
                      reference conformance {qa.conformance.overall}/10
                    </div>
                  ) : null}
                  {qa.summary.reasons.length > 0 ? (
                    <ul>
                      {qa.summary.reasons.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  ) : (
                    <div className="muted" style={{ marginTop: 6 }}>
                      all acceptance thresholds met
                    </div>
                  )}
                  {qa.slop ? (
                    <div className="muted" style={{ marginTop: 8 }}>
                      slop severity {qa.slop.projectSeverity}/10 ({qa.slop.verdict})
                    </div>
                  ) : null}
                  {qa.novelty ? (
                    <div className="muted">
                      novelty:{" "}
                      {qa.novelty.results.map((r) => `${r.sceneId} ${r.similarity}% ${r.verdict}`).join(" · ") || "n/a"}
                    </div>
                  ) : null}
                  {qa.visual?.scenes?.length ? (
                    <div className="muted" style={{ marginTop: 8 }}>
                      {qa.visual.scenes.map((s) => {
                        const rel = s.scores?.scriptRelevance;
                        const med = s.stats?.median;
                        const conf = s.stats?.confidence;
                        return `${s.sceneId}: ${rel ?? "-"}/10 rel · scene ${med ?? "-"}/10${conf !== undefined ? ` (conf ${conf.toFixed(2)})` : ""}`;
                      }).join("  |  ")}
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
};
