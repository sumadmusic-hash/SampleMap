/**
 * E-P7 — One-Time Consent (FINAL_UI_UX_DESIGN_SPEC §19.5 "Usage-acceptance gate").
 *
 * Guards the FIRST `Add to Machiniste` (app.sendToMachiniste). Once the user
 * explicitly accepts, the preference is stored and the dialog never reappears.
 * The stored value is a strict sentinel: anything other than the exact granted
 * sentinel (missing, malformed, wrong version) counts as NOT granted, so
 * storage drift can never silently re-grant consent.
 *
 * No auto-accept, no hidden acceptance, no implicit acceptance from
 * authentication/session/previous operations. Consent is app-level state; it
 * is NEVER attached to SampleIndexRecord and never stores audio bytes.
 *
 * Key is namespaced + versioned so a future semantics change can invalidate or
 * migrate without colliding with other applications.
 */
export const EP7_CONSENT_KEY = "samplemap:e-p7:consent:v1";

/** The only stored value that means GRANTED. */
export const EP7_CONSENT_GRANTED = "granted";

export type Ep7ConsentValue = "granted";

/** Parses a raw stored value strictly. Only the exact sentinel means granted. */
export function parseEp7ConsentValue(raw: string | null): boolean {
  return raw === EP7_CONSENT_GRANTED;
}

/** Minimal sync persistence surface (localStorage-backed in the browser). */
export interface Ep7ConsentStore {
  isGranted(): boolean;
  /** Persist consent. Throws when the storage write fails. */
  grant(): void;
  /** Remove any stored consent (test/reset utility — never auto-invoked). */
  clear(): void;
}

/** localStorage-backed store (used by the browser bootstrap + harness). */
export function createStorageEp7ConsentStore(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
): Ep7ConsentStore {
  return {
    isGranted: () => parseEp7ConsentValue(storage.getItem(EP7_CONSENT_KEY)),
    grant: () => storage.setItem(EP7_CONSENT_KEY, EP7_CONSENT_GRANTED),
    clear: () => storage.removeItem(EP7_CONSENT_KEY),
  };
}

/** In-memory store (tests + the controller default: safe-by-default un-granted). */
export function createMemoryEp7ConsentStore(): Ep7ConsentStore {
  let granted = false;
  return {
    isGranted: () => granted,
    grant: () => {
      granted = true;
    },
    clear: () => {
      granted = false;
    },
  };
}