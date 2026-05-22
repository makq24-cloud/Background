import { get, set, del } from 'idb-keyval';

/**
 * Lightweight session shape — what's worth persisting across reloads.
 *
 * Intentionally excludes: sourceImage, croppedImage, canvasData,
 * prealphaCanvas. These are huge (a 4500x5400 RGBA buffer is ~96 MB) and
 * can be re-derived from queuedImages[currentImageIndex] on demand.
 *
 * File objects DO survive IndexedDB's structured clone, so re-opening the
 * tab and resuming gets the user back to where they were without making
 * them re-pick all the files in the batch.
 */
export type PersistedSession = {
  version: 1;
  currentStep: number;
  currentImageIndex: number;
  alphaSettings: {
    targetColor: [number, number, number];
    alphaBase: number;
    alphaContrast: number;
  };
  platenDimensions: { width: number; height: number } | null;
  platenName: string;
  queuedImages: File[];
  // Whether the user has manually tuned the alpha settings during this
  // session — used to skip auto-detect on subsequent images in a batch.
  alphaUserTuned: boolean;
  savedAt: number;
};

const SESSION_KEY = 'dtg-bg-session-v1';

/** Save the session. Caller should debounce. */
export async function saveSession(s: Omit<PersistedSession, 'version' | 'savedAt'>): Promise<void> {
  try {
    const record: PersistedSession = { ...s, version: 1, savedAt: Date.now() };
    await set(SESSION_KEY, record);
  } catch (err) {
    // Quota / private-mode failures shouldn't crash the app.
    console.warn('Session save failed:', err);
  }
}

export async function loadSession(): Promise<PersistedSession | null> {
  try {
    const r = await get<PersistedSession>(SESSION_KEY);
    if (!r || r.version !== 1) return null;
    // Sanity: must have actual queued files to be worth resuming.
    if (!Array.isArray(r.queuedImages) || r.queuedImages.length === 0) return null;
    return r;
  } catch (err) {
    console.warn('Session load failed:', err);
    return null;
  }
}

export async function clearSession(): Promise<void> {
  try { await del(SESSION_KEY); } catch (err) { console.warn('Session clear failed:', err); }
}
