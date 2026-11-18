import { useEffect, useRef, useState } from "react";
import { createSpringAnimator, motionReduced } from "../motion";
import type { SpringAnimator } from "../motion";

/** Animate numeric updates with a ζ = 1 spring (inheriting velocity across rapid SSE updates), keeping the authoritative value on aria-label. */
export function AnimatedNumber({ value }: { value: string }) {
  const [shown, setShown] = useState(value);
  const previousUnit = useRef<string | null>(null);
  const animatorRef = useRef<SpringAnimator | null>(null);
  const formatRef = useRef<{ decimals: number; unit: string; finalText: string }>({
    decimals: 0,
    unit: "",
    finalText: value,
  });

  useEffect(() => {
    return () => {
      animatorRef.current?.destroy();
      animatorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const parsed = /^(-?[\d.]+)(.*)$/.exec(value);
    const num = parsed ? Number(parsed[1]) : Number.NaN;
    if (motionReduced() || !parsed || !Number.isFinite(num)) {
      animatorRef.current?.stop();
      previousUnit.current = parsed ? parsed[2] : null;
      setShown(value);
      return;
    }

    const decimals = (parsed[1].split(".")[1] ?? "").length;
    const unit = parsed[2];
    formatRef.current = { decimals, unit, finalText: value };

    if (!animatorRef.current || previousUnit.current !== unit) {
      animatorRef.current?.destroy();
      previousUnit.current = unit;
      animatorRef.current = createSpringAnimator(
        (current) => {
          const { decimals: d, unit: u } = formatRef.current;
          setShown(`${current.toFixed(d)}${u}`);
        },
        { initial: num, angularFrequency: 18, restDelta: 0.5 * 10 ** -decimals, restSpeed: 0.5 * 10 ** -decimals },
      );
      setShown(value);
      return;
    }

    animatorRef.current.to(num, {
      onRest: () => setShown(formatRef.current.finalText),
    });
  }, [value]);

  return (
    <span className="kpi-number" aria-label={value}>
      <span aria-hidden="true">{shown}</span>
    </span>
  );
}

export function formatChineseUnit(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) < 10000) return "";
  const unit = Math.abs(value) >= 1e12 ? 1e12 : Math.abs(value) >= 1e8 ? 1e8 : 1e4;
  return `${(value / unit).toFixed(2).replace(/\.?0+$/, "")}${unit === 1e12 ? "万亿" : unit === 1e8 ? "亿" : "万"}`;
}
