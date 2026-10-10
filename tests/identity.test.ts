import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  canonicalJson,
  sha256Json,
  fingerprintFile,
  sha256File,
  scenesFingerprint,
} from "../src/core/identity";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "identity-"));

describe("canonical identity (A4)", () => {
  it("canonical json is independent of key order and nested formatting", () => {
    const a = { b: 1, a: { d: 4, c: 3 }, list: [{ z: 1, y: 2 }] };
    const b = { list: [{ y: 2, z: 1 }], a: { c: 3, d: 4 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(sha256Json(a)).toBe(sha256Json(b));
  });

  it("canonical json changes when a value changes", () => {
    expect(sha256Json({ a: 1 })).not.toBe(sha256Json({ a: 2 }));
    expect(sha256Json([1, 2])).not.toBe(sha256Json([2, 1]));
  });

  it("file fingerprint: same bytes => same identity, changed bytes => new identity", () => {
    const dir = tmp();
    const file = path.join(dir, "artifact.mp4");
    fs.writeFileSync(file, "AAA-RENDER-BYTES");
    const first = fingerprintFile(file);
    expect(first).not.toBeNull();
    expect(first!.sizeBytes).toBe("AAA-RENDER-BYTES".length);

    const again = fingerprintFile(file);
    expect(again!.sha256).toBe(first!.sha256);

    fs.writeFileSync(file, "BBB-RENDER-BYTES-CHANGED");
    const changed = fingerprintFile(file);
    expect(changed!.sha256).not.toBe(first!.sha256);
    expect(sha256File(file)).toBe(changed!.sha256);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("file fingerprint returns null for a missing artifact", () => {
    expect(fingerprintFile(path.join(tmp(), "nope.mp4"))).toBeNull();
  });

  it("scene fingerprint is stable for the same state and tracks per-scene changes", () => {
    const s1 = { sceneId: "scene_01", duration: 3, elements: [{ primitive: "Circle" }] };
    const s2 = { sceneId: "scene_02", duration: 4, elements: [{ primitive: "Line" }] };
    const first = scenesFingerprint([s1, s2]);
    const same = scenesFingerprint([structuredClone(s1), structuredClone(s2)]);
    expect(same.scenesHash).toBe(first.scenesHash);
    expect(same.sceneHashes).toEqual(first.sceneHashes);

    const mutated = scenesFingerprint([s1, { ...s2, duration: 5 }]);
    expect(mutated.scenesHash).not.toBe(first.scenesHash);
    expect(mutated.sceneHashes.scene_01).toBe(first.sceneHashes.scene_01);
    expect(mutated.sceneHashes.scene_02).not.toBe(first.sceneHashes.scene_02);
  });
});
