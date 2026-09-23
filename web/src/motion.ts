const animations = new WeakMap<HTMLElement, Animation>();
export const WT_REVEAL_DURATION_MS = 160;
export const WT_HIDE_DURATION_MS = 120;
export function motionReduced(): boolean { return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches; }
/** Last caller wins. A cancelled exit must never close a subsequently reopened surface. */
export function animatePresence(element: HTMLElement, visible: boolean, settled?: () => void): () => void {
  animations.get(element)?.cancel(); animations.delete(element);
  if (motionReduced() || typeof element.animate !== "function") { settled?.(); return () => {}; }
  const frames = [{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "translateY(0)" }];
  const animation = element.animate(visible ? frames : [...frames].reverse(), { duration: visible ? WT_REVEAL_DURATION_MS : WT_HIDE_DURATION_MS, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: visible ? "backwards" : "forwards" });
  animations.set(element, animation);
  void animation.finished.then(() => { if (animations.get(element) === animation) { animations.delete(element); animation.cancel(); settled?.(); } }).catch(() => {});
  return () => { if (animations.get(element) === animation) animations.delete(element); animation.cancel(); };
}
