import { useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
export interface BarSegment { label: string; width?: number; className?: string; style?: CSSProperties; lines?: string[]; onSelect?: () => void }
export function hoverCardPosition(anchorX: number, width: number, cardWidth: number): number {
  const gap = 12; const preferred = anchorX > width * 0.62 ? anchorX - cardWidth - gap : anchorX + gap;
  return Math.max(0, Math.min(preferred, Math.max(0, width - cardWidth)));
}
/** The same bar/tooltip geometry is shared by status, error buckets and request timings. */
export function SegmentBar({ segments, className = "", label }: { segments: BarSegment[]; className?: string; label: string }) {
  const [hovered, setHovered] = useState<{ index: number; x: number } | null>(null);
  const host = useRef<HTMLDivElement>(null), card = useRef<HTMLDivElement>(null);
  const tooltipId = useId();
  const active = hovered ? segments[hovered.index] : null;
  useLayoutEffect(() => {
    if (host.current && card.current && hovered) { card.current.style.left = `${hoverCardPosition(hovered.x, host.current.clientWidth, card.current.offsetWidth)}px`; card.current.style.bottom = "calc(100% + 8px)"; }
  }, [hovered]);
  return <div ref={host} className="wt-hovercard-host" onMouseLeave={() => setHovered(null)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setHovered(null); }} onKeyDown={(event) => { if (event.key === "Escape") setHovered(null); }}>
    <div className={`wt-segbar ${className}`} role="group" aria-label={label}>{segments.filter((segment) => segment.width === undefined || segment.width > 0).map((segment) => {
      const index = segments.indexOf(segment);
      const style: CSSProperties = {
        ...(segment.width !== undefined ? { width: `${Math.max(0, segment.width)}%` } : {}),
        ...(segment.style ?? {}),
      };
      return <span key={index} className={`wt-segbar-seg is-hoverable ${segment.className ?? ""}`} style={style} role={segment.onSelect ? "button" : "img"} tabIndex={0} aria-label={[segment.label, ...(segment.lines ?? [])].join("；")} aria-describedby={hovered?.index === index ? tooltipId : undefined}
        onMouseMove={(event) => setHovered({ index, x: event.clientX - (host.current?.getBoundingClientRect().left ?? 0) })}
        onFocus={(event) => setHovered({ index, x: event.currentTarget.offsetLeft + event.currentTarget.offsetWidth / 2 })}
        onClick={segment.onSelect} onKeyDown={(event) => { if (segment.onSelect && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); segment.onSelect(); } }} />;
    })}</div>
    <div ref={card} id={tooltipId} role="tooltip" className="wt-hovercard" hidden={!active}><strong>{active?.label}</strong>{active?.lines?.map((line, index) => <span key={index}>{line}</span>)}</div>
  </div>;
}
