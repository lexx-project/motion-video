import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { writeJsonAt } from "../src/core/projectStore";
import { scenesFingerprint } from "../src/core/identity";
import {
  createSnapshot,
  createSnapshotUnique,
  currentSceneFingerprint,
  latestSnapshot,
  listSnapshots,
  readSnapshot,
  restoreSnapshot,
  sanitize,
  snapshotMatchesState,
} from "../src/core/snapshot";

const sceneV1 = { sceneId: "scene_01", duration: 3, purpose: "p", elements: [{ primitive: "Circle" }] };
const sceneV2 = { ...sceneV1, duration: 5 };
const scene02 = { sceneId: "scene_02", duration: 2, purpose: "q", elements: [{ primitive: "Line" }] };

const makeProject = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snapshot-"));
  writeJsonAt(dir, "scenes/scene_01.json", sceneV1);
  return dir;
};

describe("snapshot + restore (A5)", () => {
  it("captures scene state plus artifact and QA identity", () => {
    const dir = makeProject();
    const rec = createSnapshot(dir, "round-1-baseline", {
      render: { file: "renders/preview.mp4", sha256: "renderhash" },
      qa: { qaSha256: "qahash", status: "needs_repair", renderSha256: "renderhash" },
    });
    expect(rec.schema).toBe("snapshot/1");
    expect(rec.scenesHash).toBe(scenesFingerprint([sceneV1]).scenesHash);
    expect(rec.sceneIds).toEqual(["scene_01"]);
    expect(rec.render).toEqual({ file: "renders/preview.mp4", sha256: "renderhash" });
    expect(rec.qa!.status).toBe("needs_repair");
    expect(fs.existsSync(path.join(dir, "snapshots", "round-1-baseline", "scenes", "scene_01.json"))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("restores the previous scene state and verifies it by hash", () => {
    const dir = makeProject();
    const rec = createSnapshot(dir, "baseline");

    writeJsonAt(dir, "scenes/scene_01.json", sceneV2);
    expect(currentSceneFingerprint(dir).scenesHash).not.toBe(rec.scenesHash);
    expect(snapshotMatchesState(rec, [sceneV1])).toBe(true);
    expect(snapshotMatchesState(rec, [sceneV2])).toBe(false);

    const restored = restoreSnapshot(dir, "baseline");
    expect(restored.restored).toEqual(["scene_01"]);
    expect(restored.extras).toEqual([]);
    expect(restored.verified).toBe(true);
    expect(currentSceneFingerprint(dir).scenesHash).toBe(rec.scenesHash);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("never destroys scenes the snapshot does not contain, and says so", () => {
    const dir = makeProject();
    createSnapshot(dir, "baseline");
    writeJsonAt(dir, "scenes/scene_02.json", scene02);

    const restored = restoreSnapshot(dir, "baseline");
    expect(restored.restored).toEqual(["scene_01"]);
    expect(restored.extras).toEqual(["scene_02"]);
    expect(restored.verified).toBe(false);
    expect(fs.existsSync(path.join(dir, "scenes", "scene_02.json"))).toBe(true);

    fs.rmSync(path.join(dir, "scenes", "scene_02.json"));
    expect(restoreSnapshot(dir, "baseline").verified).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses to overwrite a baseline that holds different state", () => {
    const dir = makeProject();
    createSnapshot(dir, "baseline");
    expect(() => createSnapshot(dir, "baseline", { scenes: [sceneV2] })).toThrow(/already exists with different state/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("createSnapshotUnique resolves label collisions without losing the baseline", () => {
    const dir = makeProject();
    const a = createSnapshotUnique(dir, "round-1-baseline", { scenes: [sceneV1] });
    const same = createSnapshotUnique(dir, "round-1-baseline", { scenes: [sceneV1] });
    expect(same.label).toBe(a.label); // identical state reuses the baseline
    const b = createSnapshotUnique(dir, "round-1-baseline", { scenes: [sceneV2] });
    expect(b.label).toBe("round-1-baseline-2");
    expect(readSnapshot(dir, a.label)!.scenesHash).toBe(scenesFingerprint([sceneV1]).scenesHash);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lists snapshots in order and exposes the latest restorable baseline", () => {
    const dir = makeProject();
    createSnapshot(dir, "first");
    writeJsonAt(dir, "scenes/scene_01.json", sceneV2);
    createSnapshot(dir, "second");
    const all = listSnapshots(dir);
    expect(all.map((s) => s.label)).toEqual(["first", "second"]);
    expect(latestSnapshot(dir)!.label).toBe("second");
    expect(latestSnapshot(dir)!.scenesHash).toBe(scenesFingerprint([sceneV2]).scenesHash);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sanitizes labels for filesystem safety", () => {
    expect(sanitize("round 1 / baseline")).toBe("round-1-baseline");
    expect(sanitize("...")).toBe("...");
    expect(sanitize("")).toMatch(/^snap-/);
  });
});
