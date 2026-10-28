import { useCallback, useEffect, useRef, useState } from "preact/hooks";

export interface AsyncState<T> { data: T | undefined; error: string | null; loading: boolean; reload: () => void }

/** Loads data with `fn` whenever `deps` change; `reload()` re-runs it. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<{ data: T | undefined; error: string | null; loading: boolean }>({ data: undefined, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    fnRef.current().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (e: unknown) => alive && setState({ data: undefined, error: errorText(e), loading: false }),
    );
    return () => { alive = false; };
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return "Unbekannter Fehler. Bitte erneut versuchen.";
}
