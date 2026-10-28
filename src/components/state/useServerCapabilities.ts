"use client";

import { useEffect, useState } from "react";
import type { ServerCapabilities } from "@/src/lib/types/capabilities";

// One request per page load, shared by every screen. A failed request is not cached, so a
// later mount retries.
let pending: Promise<ServerCapabilities> | null = null;

function loadCapabilities(): Promise<ServerCapabilities> {
  pending ??= fetch("/api/extract", { cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<ServerCapabilities>) : Promise.reject(new Error(`HTTP ${r.status}`))))
    .catch((error: unknown) => {
      pending = null;
      throw error;
    });
  return pending;
}

export function useServerCapabilities(): { data: ServerCapabilities | null; error: string | null } {
  const [state, setState] = useState<{ data: ServerCapabilities | null; error: string | null }>({ data: null, error: null });
  useEffect(() => {
    let cancelled = false;
    loadCapabilities()
      .then((data) => !cancelled && setState({ data, error: null }))
      .catch((error: unknown) => !cancelled && setState({ data: null, error: error instanceof Error ? error.message : String(error) }));
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}
