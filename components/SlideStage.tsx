"use client";

// Wraps any slide in the scale-to-fit canvas. Used identically by the full main
// view and the small presenter previews — the same primitive at any size.

import type { ReactNode } from "react";
import { useScaleToFit } from "@/lib/useScaleToFit";

export function SlideStage({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const { containerRef, scale } = useScaleToFit();
  return (
    <div ref={containerRef} className={`stage-viewport ${className ?? ""}`.trim()}>
      <div className="slide-canvas" style={{ transform: `scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}
