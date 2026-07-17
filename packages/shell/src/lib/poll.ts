import { useEffect, useState } from "react";

/** Poll an async getter on an interval; undefined until first resolve. */
export function usePoll<T>(fn: () => Promise<T>, ms: number): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    const tick = () => fn().then((v) => { if (alive) setValue(v); }).catch(() => {});
    tick();
    const t = setInterval(tick, ms);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms]);
  return value;
}

export const MODEL_COLORS = ["#3b82f6", "#ef4444", "#f59e0b", "#a855f7", "#22c55e", "#0ea5e9", "#ec4899"];

export function fmtK(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
