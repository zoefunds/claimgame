import { useEffect } from "react";

/**
 * setInterval that pauses while the tab is hidden/backgrounded — a browser
 * tab left open in the background doesn't need to keep re-fetching. Small
 * extra margin against unnecessary request volume on top of routing all
 * polling through the backend cache instead of GenLayer directly (see
 * app/claims/page.tsx's module docstring for the bigger reason).
 */
export function usePolling(callback: () => void, intervalMs: number): void {
  useEffect(() => {
    let id: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (id) return;
      id = setInterval(callback, intervalMs);
    };
    const stop = () => {
      if (id) clearInterval(id);
      id = null;
    };

    const handleVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        callback();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [callback, intervalMs]);
}
