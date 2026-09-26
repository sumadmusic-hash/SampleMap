import { describe, it, expect } from "vitest";
import {
  EP7_CONSENT_KEY,
  EP7_CONSENT_GRANTED,
  parseEp7ConsentValue,
  createMemoryEp7ConsentStore,
  createStorageEp7ConsentStore,
} from "./ep7Consent";

/**
 * STEP19A E-P7 — consent persistence unit tests.
 *
 * Safety rule: consent is only ever true for the exact granted sentinel.
 * Missing, malformed or drifted stored values must count as NOT granted and
 * can NEVER silently re-grant the one-time consent.
 */

function fakeStorage(seed: Record<string, string> = {}): {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  raw: Map<string, string>;
} {
  const raw = new Map(Object.entries(seed));
  return {
    storage: {
      getItem: (k: string) => raw.get(k) ?? null,
      setItem: (k: string, v: string) => {
        raw.set(k, v);
      },
      removeItem: (k: string) => {
        raw.delete(k);
      },
    },
    raw,
  };
}

describe("E-P7 consent parsing (strict sentinel)", () => {
  it("grants ONLY the exact canonical sentinel", () => {
    expect(parseEp7ConsentValue(EP7_CONSENT_GRANTED)).toBe(true);
  });

  it("every non-sentinel value is NOT granted (never silently re-granted)", () => {
    for (const raw of [null, "", "Granted", "GRANTED", "true", "1", "yes", "truee"]) {
      expect(parseEp7ConsentValue(raw)).toBe(false);
    }
  });
});

describe("E-P7 in-memory store (safe default)", () => {
  it("starts NOT granted; grant + isGranted round-trip; clear resets", () => {
    const s = createMemoryEp7ConsentStore();
    expect(s.isGranted()).toBe(false);
    s.grant();
    expect(s.isGranted()).toBe(true);
    s.clear();
    expect(s.isGranted()).toBe(false);
  });
});

describe("E-P7 storage store (namespaced + versioned key)", () => {
  it("uses the stable namespaced key", () => {
    expect(EP7_CONSENT_KEY).toBe("samplemap:e-p7:consent:v1");
  });

  it("writes the exact sentinel through setItem", () => {
    const { storage, raw } = fakeStorage();
    const s = createStorageEp7ConsentStore(storage);
    expect(s.isGranted()).toBe(false);
    s.grant();
    expect(raw.get(EP7_CONSENT_KEY)).toBe(EP7_CONSENT_GRANTED);
    expect(s.isGranted()).toBe(true);
  });

  it("survives store recreation (persistence semantics: same key, same value)", () => {
    const { storage } = fakeStorage();
    createStorageEp7ConsentStore(storage).grant();
    const revived = createStorageEp7ConsentStore(storage);
    expect(revived.isGranted()).toBe(true);
  });

  it("a drift/corrupt stored value reads as NOT granted", () => {
    const { storage } = fakeStorage({ [EP7_CONSENT_KEY]: "true" });
    expect(createStorageEp7ConsentStore(storage).isGranted()).toBe(false);
  });

  it("clear removes the key (test/reset utility only)", () => {
    const { storage, raw } = fakeStorage({ [EP7_CONSENT_KEY]: EP7_CONSENT_GRANTED });
    const s = createStorageEp7ConsentStore(storage);
    expect(s.isGranted()).toBe(true);
    s.clear();
    expect(raw.has(EP7_CONSENT_KEY)).toBe(false);
    expect(s.isGranted()).toBe(false);
  });
});