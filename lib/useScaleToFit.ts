"use client";

// Scale-to-fit canvas (slide-system-rules.md §2): render the slide at a fixed
// 1280×720 design size, then scale the *whole canvas* with a CSS transform to
// fit whatever box it sits in — centered and letterboxed, never reflowed.
// Works for any container size, so the presenter view's small "next" preview
// uses the exact same primitive as the full-screen main view.

import { useEffect, useRef, useState } from "react";

export const DESIGN_WIDTH = 1280;
export const DESIGN_HEIGHT = 720;

export function useScaleToFit(designW = DESIGN_WIDTH, designH = DESIGN_HEIGHT) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const compute = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w === 0 || h === 0) return;
      setScale(Math.min(w / designW, h / designH));
    };

    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    window.addEventListener("resize", compute);
    window.addEventListener("orientationchange", compute);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", compute);
      window.removeEventListener("orientationchange", compute);
    };
  }, [designW, designH]);

  return { containerRef, scale };
}
