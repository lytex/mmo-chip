/**
 * PerfHud.tsx — optional FPS / render-diagnostics strip in the canvas
 * corner. Reads the renderer's own accounting (rendererPerfStats) plus a
 * plain rAF fps counter; DOM text updates at 4 Hz, so the HUD itself never
 * enters the frame budget it reports on.
 */

import { useEffect, useRef } from "react";
import { rendererPerfStats } from "../../renderer/TiledRenderer";

export function PerfHud() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const stamps: number[] = [];
    const tick = (t: number) => {
      stamps.push(t);
      while (stamps.length > 0 && stamps[0] < t - 1000) stamps.shift();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const id = window.setInterval(() => {
      const el = ref.current;
      if (!el) return;
      let reason = rendererPerfStats.lastReason;
      if (reason.length > 48) reason = `${reason.slice(0, 45)}…`;
      el.textContent = `${stamps.length} fps · render ${rendererPerfStats.lastFrameMs.toFixed(0)} ms · ${reason}`;
    }, 250);
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(id);
    };
  }, []);

  return (
    <div
      ref={ref}
      style={{
        position: "absolute",
        left: 8,
        bottom: 8,
        zIndex: 30,
        font: "10px/1.4 ui-monospace, monospace",
        color: "#9ec9a2",
        background: "rgba(12,12,8,0.7)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 4,
        padding: "3px 7px",
        pointerEvents: "none",
        whiteSpace: "nowrap",
      }}
    />
  );
}
