"use client";

// Cross-tab sync with NO server (slide-system-rules.md §5). Prefers
// BroadcastChannel; falls back to localStorage `storage` events so the main
// view and presenter view stay in lock-step in the same browser on one laptop
// (the projector-as-second-display setup).

export interface SyncMessage {
  type: "state" | "request";
  index?: number;
  step?: number;
}

export interface SyncChannel {
  post: (msg: SyncMessage) => void;
  close: () => void;
}

export function createSyncChannel(
  name: string,
  onMessage: (msg: SyncMessage) => void,
): SyncChannel {
  if (typeof window === "undefined") {
    return { post: () => {}, close: () => {} };
  }

  // Preferred path: BroadcastChannel. (Use a typeof check, not `in window`, so
  // TypeScript doesn't narrow `window` to `never` in the fallback branch.)
  if (typeof BroadcastChannel !== "undefined") {
    const bc = new BroadcastChannel(`deck:${name}`);
    bc.onmessage = (e: MessageEvent<SyncMessage>) => onMessage(e.data);
    return {
      post: (msg) => bc.postMessage(msg),
      close: () => bc.close(),
    };
  }

  // Fallback: localStorage. Writing a key fires `storage` in *other* tabs.
  const key = `deck-sync:${name}`;
  const handler = (e: StorageEvent) => {
    if (e.key !== key || !e.newValue) return;
    try {
      const parsed = JSON.parse(e.newValue) as SyncMessage;
      onMessage(parsed);
    } catch {
      /* ignore malformed payloads */
    }
  };
  window.addEventListener("storage", handler);
  let seq = 0;
  return {
    // Include a changing nonce so identical consecutive states still fire storage.
    post: (msg) => {
      seq += 1;
      window.localStorage.setItem(key, JSON.stringify({ ...msg, _n: seq }));
    },
    close: () => window.removeEventListener("storage", handler),
  };
}
