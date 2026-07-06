"use client";

// Fullscreen for the MAIN view only (slide-system-rules.md §4). `F` and a
// visible button both call toggle(); F11 still works as the browser default.

import { useCallback, useEffect, useState } from "react";

interface FullscreenDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void>;
}
interface FullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void>;
}

export function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () => {
      const doc = document as FullscreenDocument;
      setIsFullscreen(Boolean(doc.fullscreenElement || doc.webkitFullscreenElement));
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);

  const toggle = useCallback(async (el: HTMLElement | null) => {
    const doc = document as FullscreenDocument;
    try {
      if (doc.fullscreenElement || doc.webkitFullscreenElement) {
        if (doc.exitFullscreen) await doc.exitFullscreen();
        else if (doc.webkitExitFullscreen) await doc.webkitExitFullscreen();
      } else if (el) {
        const fe = el as FullscreenElement;
        if (fe.requestFullscreen) await fe.requestFullscreen();
        else if (fe.webkitRequestFullscreen) await fe.webkitRequestFullscreen();
      }
    } catch {
      /* requires a user gesture or is unsupported — ignore */
    }
  }, []);

  return { isFullscreen, toggle };
}
