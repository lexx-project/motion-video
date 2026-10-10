import { describe, it, expect } from "vitest";
import {
  combineEventStatus,
  PIXEL_REQUIRED_EVENT_TYPES,
  EVENT_PIXEL_DIFF_FLOOR,
  EVENT_MIN_OBJECT_INK,
} from "../src/agents/eventEvidence";

/**
 * Batch E Phase 5: event-to-pixel cross-check.
 * state / pixel_change / identity are SEPARATE dimensions; combined never claims more
 * than the identity method can prove.
 */

describe("event cross-check status separation", () => {
  it("state=PASS + verified pixels + verified identity -> PASS", () => {
    expect(
      combineEventStatus({ state: "PASS", pixelChange: "PASS", identity: "PASS", pixelRequired: true }),
    ).toEqual({ combined: "PASS" });
  });

  it("state=PASS + pixel PASS + identity NOT_VERIFIED -> NOT_VERIFIED (never overclaim)", () => {
    expect(
      combineEventStatus({ state: "PASS", pixelChange: "PASS", identity: "NOT_VERIFIED", pixelRequired: true }),
    ).toEqual({ combined: "NOT_VERIFIED" });
  });

  it("state=FAIL always yields FAIL, whatever the other dimensions say", () => {
    expect(combineEventStatus({ state: "FAIL", pixelChange: "PASS", identity: "PASS", pixelRequired: true })).toEqual({
      combined: "FAIL",
    });
    expect(
      combineEventStatus({ state: "FAIL", pixelChange: "FAIL", identity: "NOT_VERIFIED", pixelRequired: true }),
    ).toEqual({ combined: "FAIL" });
    expect(
      combineEventStatus({ state: "FAIL", pixelChange: "NOT_APPLICABLE", identity: "NOT_VERIFIED", pixelRequired: false }),
    ).toEqual({ combined: "FAIL" });
  });

  it("verified pixels contradicting a required visual change -> FAIL", () => {
    expect(
      combineEventStatus({ state: "PASS", pixelChange: "FAIL", identity: "PASS", pixelRequired: true }),
    ).toEqual({ combined: "FAIL" });
  });

  it("identity NOT_VERIFIED downgrades an unverified pixel FAIL (attribution uncertain)", () => {
    expect(
      combineEventStatus({ state: "PASS", pixelChange: "FAIL", identity: "NOT_VERIFIED", pixelRequired: true }),
    ).toEqual({ combined: "NOT_VERIFIED" });
  });

  it("event-specific rule: invisible events (attach/detach) need no pixel change", () => {
    expect(PIXEL_REQUIRED_EVENT_TYPES).not.toContain("attach");
    expect(PIXEL_REQUIRED_EVENT_TYPES).not.toContain("detach");
    expect(PIXEL_REQUIRED_EVENT_TYPES).toContain("move");
    expect(PIXEL_REQUIRED_EVENT_TYPES).toContain("enter");
    expect(
      combineEventStatus({ state: "PASS", pixelChange: "NOT_APPLICABLE", identity: "PASS", pixelRequired: false }),
    ).toEqual({ combined: "PASS" });
    // ...but an invisible event with a required pixel change would still fail
    expect(
      combineEventStatus({ state: "PASS", pixelChange: "FAIL", identity: "PASS", pixelRequired: true }),
    ).toEqual({ combined: "FAIL" });
  });
});

describe("pixel evidence thresholds are explicit", () => {
  it("uses documented finite floors (no fabricated confidence)", () => {
    expect(EVENT_PIXEL_DIFF_FLOOR).toBeGreaterThan(0);
    expect(EVENT_PIXEL_DIFF_FLOOR).toBeLessThan(1);
    expect(EVENT_MIN_OBJECT_INK).toBeGreaterThan(0);
    expect(EVENT_MIN_OBJECT_INK).toBeLessThan(EVENT_PIXEL_DIFF_FLOOR);
  });
});
