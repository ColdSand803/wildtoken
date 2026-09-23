import { useEffect, useRef, useState } from "react";
import { motionReduced } from "../motion";
/** Animate numeric updates, but keep the authoritative formatted value as the accessible label. */
export function AnimatedNumber({ value }: { value: string }) {
  const [shown, setShown] = useState(value);
  const previous = useRef(value);
  useEffect(() => {
    const old = /^(-?[\d.]+)(.*)$/.exec(previous.current), next = /^(-?[\d.]+)(.*)$/.exec(value);
    previous.current = value;
    if (motionReduced() || !old || !next || old[2] !== next[2] || !Number.isFinite(Number(next[1]))) { setShown(value); return; }
    const from = Number(old[1]), to = Number(next[1]), decimals = (next[1].split(".")[1] ?? "").length;
    let frame = 0; const start = performance.now();
    const step = (now: number) => { const t = Math.min(1, (now - start) / 520); setShown(`${(from + (to - from) * (1 - (1 - t) ** 3)).toFixed(decimals)}${next[2]}`); if (t < 1) frame = requestAnimationFrame(step); else setShown(value); };
    frame = requestAnimationFrame(step); return () => cancelAnimationFrame(frame);
  }, [value]);
  return <span className="kpi-number" aria-label={value}><span aria-hidden="true">{shown}</span></span>;
}
export function formatChineseUnit(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) < 10000) return "";
  const unit = Math.abs(value) >= 1e12 ? 1e12 : Math.abs(value) >= 1e8 ? 1e8 : 1e4;
  return `${(value / unit).toFixed(2).replace(/\.?0+$/, "")}${unit === 1e12 ? "万亿" : unit === 1e8 ? "亿" : "万"}`;
}
