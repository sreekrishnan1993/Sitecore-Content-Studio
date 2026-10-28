"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncData<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
}

/** Loads data whenever `key` changes. Pass `null` as key to skip loading. */
export function useAsyncData<T>(key: string | null, load: () => Promise<T>): AsyncData<T> {
  const [state, setState] = useState<{ key: string | null; data?: T; error?: string }>({ key: null });
  const [attempt, setAttempt] = useState(0);
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });

  const fullKey = key === null ? null : `${key}#${attempt}`;

  useEffect(() => {
    if (fullKey === null) return;
    let cancelled = false;
    loadRef
      .current()
      .then((data) => {
        if (!cancelled) setState({ key: fullKey, data });
      })
      .catch((error: unknown) => {
        console.error("Content Studio: request failed", error);
        if (!cancelled) setState({ key: fullKey, error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [fullKey]);

  const reload = useCallback(() => setAttempt((a) => a + 1), []);
  const current = state.key === fullKey;
  return { data: current ? state.data : undefined, error: current ? state.error : undefined, loading: fullKey !== null && !current, reload };
}
