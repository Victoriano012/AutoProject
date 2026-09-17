import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/** Layout reads happen on moves, resize and a single animation frame after
 * scrolling. Agent output does not render the board or trigger measurement. */
export function useBoardAnimation(layoutKey: string) {
  const elements = useRef(new Map<string, HTMLDivElement>());
  const previous = useRef(new Map<string, DOMRect>());
  const observer = useRef<ResizeObserver | null>(null);
  const frame = useRef<number | null>(null);
  const measure = useCallback(() => {
    const rects = new Map<string, DOMRect>();
    for (const [id, el] of elements.current) {
      if (el.isConnected) rects.set(id, el.getBoundingClientRect());
    }
    return rects;
  }, []);
  const refresh = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      previous.current = measure();
    });
  }, [measure]);
  const register = useCallback((id: string, el: HTMLDivElement | null) => {
    const old = elements.current.get(id);
    if (old) observer.current?.unobserve(old);
    if (el) {
      elements.current.set(id, el);
      observer.current?.observe(el);
    } else elements.current.delete(id);
  }, []);
  useEffect(() => {
    observer.current = new ResizeObserver(refresh);
    for (const el of elements.current.values()) observer.current.observe(el);
    window.addEventListener("resize", refresh);
    return () => {
      observer.current?.disconnect();
      window.removeEventListener("resize", refresh);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [refresh]);
  useLayoutEffect(() => {
    const next = measure();
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      for (const [id, rect] of next) {
        const old = previous.current.get(id);
        if (!old) continue;
        const dx = old.left - rect.left, dy = old.top - rect.top;
        const card = elements.current.get(id)?.firstElementChild;
        if (card && (Math.abs(dx) > 1 || Math.abs(dy) > 1)) {
          card.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
            { duration: 300, easing: "ease" });
        }
      }
    }
    previous.current = next;
  }, [layoutKey, measure]);
  return { register, onScroll: refresh };
}
