import { useEffect, useRef, useState } from "react";

/** Runs an async loader whenever deps change; aborts stale requests. */
export function useAsync<T>(
  loader: (signal: AbortSignal) => Promise<T>, deps: unknown[], delayMs = 0,
): { data: T | null; error: Error | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      loaderRef.current(ctrl.signal)
        .then((d) => { if (!ctrl.signal.aborted) { setData(d); setError(null); } })
        .catch((e) => { if (!ctrl.signal.aborted && e.name !== "AbortError") setError(e); })
        .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    }, delayMs);
    return () => { clearTimeout(timer); ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}
