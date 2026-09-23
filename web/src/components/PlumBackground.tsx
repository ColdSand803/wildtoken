import { useEffect, useRef } from "react";
import { mountPlum } from "../plum";
export function PlumBackground() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => ref.current ? mountPlum(ref.current) : undefined, []);
  return <div className="plum" aria-hidden="true" hidden><canvas ref={ref} /></div>;
}
