/**
 * useSpicePersistence — persist model file and directives per die/subcircuit.
 *
 * Uses localStorage with keys:
 *   mmo-chip-spice-model:{dieId} → model file text
 *   mmo-chip-spice-directives:{dieId}:{subcircuitName} → directives text
 */

import { useCallback, useEffect, useState } from "react";

const MODEL_KEY_PREFIX = "mmo-chip-spice-model:";
const DIRECTIVES_KEY_PREFIX = "mmo-chip-spice-directives:";

function safeGet(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeSet(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* quota exceeded */ }
}

/**
 * Persist model file text for a specific die.
 */
export function useModelFile(dieId: string, defaultValue: string) {
  const [value, setValue] = useState(() => {
    return safeGet(MODEL_KEY_PREFIX + dieId) ?? defaultValue;
  });

  useEffect(() => {
    const loaded = safeGet(MODEL_KEY_PREFIX + dieId);
    if (loaded !== null) setValue(loaded);
  }, [dieId]);

  const set = useCallback((v: string) => {
    setValue(v);
    safeSet(MODEL_KEY_PREFIX + dieId, v);
  }, [dieId]);

  return [value, set] as const;
}

/**
 * Persist ngspice directives for a specific die + subcircuit combination.
 */
export function useDirectives(dieId: string, subcircuitName: string | null, defaultValue: string) {
  const storageKey = DIRECTIVES_KEY_PREFIX + dieId + ":" + (subcircuitName ?? "__full__");

  const [value, setValue] = useState(() => {
    return safeGet(storageKey) ?? defaultValue;
  });

  // Reset when subcircuit changes
  useEffect(() => {
    const loaded = safeGet(storageKey);
    setValue(loaded ?? defaultValue);
  }, [storageKey]);

  const set = useCallback((v: string) => {
    setValue(v);
    safeSet(storageKey, v);
  }, [storageKey]);

  return [value, set] as const;
}
