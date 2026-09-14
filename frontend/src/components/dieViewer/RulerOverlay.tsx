import { useEffect, useRef } from "react";
import type { LiveValue } from "../../lib/liveValue";
import type { Viewport } from "../../renderer/types";
import type { RulerMeasurement } from "shared";

export interface RulerDraft {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface RulerOverlayProps {
  rulers: RulerMeasurement[];
  draftStore: LiveValue<RulerDraft | null>;
  pendingStore: LiveValue<RulerDraft | null>;
  viewportStore: LiveValue<Viewport | null>;
  selectedIds?: ReadonlySet<string>;
  umPerPx?: number;
  showPx?: boolean;
  showUm?: boolean;
  showNm?: boolean;
}

function formatMeasurement(
  lengthPx: number,
  umPerPx: number,
  showPx: boolean,
  showUm: boolean,
  showNm: boolean,
): string {
  const parts: string[] = [];
  if (showPx) parts.push(`${Math.round(lengthPx).toLocaleString()} px`);
  if (umPerPx > 0 && (showUm || showNm)) {
    const um = lengthPx * umPerPx;
    if (showNm || um < 1) parts.push(`${(um * 1000).toFixed(0)} nm`);
    else parts.push(`${um.toFixed(1)} µm`);
  }
  return parts.length > 0 ? parts.join("  ") : "—";
}

function drawRuler(
  ctx: CanvasRenderingContext2D,
  ruler: RulerDraft,
  vp: Viewport,
  label: string,
  selected: boolean,
) {
  const worldToScreen = (wx: number, wy: number) => ({
    x: (wx - vp.originX) * vp.zoom,
    y: (wy - vp.originY) * vp.zoom,
  });
  const p1 = worldToScreen(ruler.x1, ruler.y1);
  const p2 = worldToScreen(ruler.x2, ruler.y2);
  const midX = (p1.x + p2.x) / 2;
  const midY = (p1.y + p2.y) / 2;
  const screenLength = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
  const nx = -(p2.y - p1.y) / screenLength;
  const ny = (p2.x - p1.x) / screenLength;
  const fontSize = Math.min(24, 11 + 1.5 * Math.max(0, Math.log2(Math.max(vp.zoom, 1))));
  const labelOffset = fontSize + 5;
  const labelX = midX + nx * labelOffset;
  const labelY = midY + ny * labelOffset;

  ctx.save();
  ctx.strokeStyle = selected ? "#ffffff" : "#ffd966";
  ctx.fillStyle = selected ? "#ffffff" : "#ffd966";
  ctx.lineWidth = selected ? 3 : 2;
  ctx.setLineDash(selected ? [] : [5, 4]);
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const p of [p1, p2]) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, selected ? 5 : 4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.font = `${fontSize}px var(--mono, monospace)`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const textWidth = ctx.measureText(label).width;
  const boxHeight = fontSize + 8;
  ctx.fillStyle = selected ? "rgba(55,55,55,0.92)" : "rgba(0,0,0,0.75)";
  ctx.fillRect(labelX - textWidth / 2 - 6, labelY - boxHeight / 2, textWidth + 12, boxHeight);
  ctx.fillStyle = selected ? "#ffffff" : "#ffd966";
  ctx.fillText(label, labelX, labelY);
  ctx.restore();
}

/** Canvas overlay for all saved rulers plus the current drag preview. */
export function RulerOverlay({
  rulers,
  draftStore,
  pendingStore,
  viewportStore,
  selectedIds = new Set<string>(),
  umPerPx = 0,
  showPx = false,
  showUm = true,
  showNm = false,
}: RulerOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => {
      const parent = canvas.parentElement;
      const vp = viewportStore.get();
      if (!parent || !vp) return;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      for (const ruler of rulers) {
        drawRuler(
          ctx,
          ruler,
          vp,
          formatMeasurement(ruler.lengthPx, umPerPx, showPx, showUm, showNm),
          selectedIds.has(ruler.id),
        );
      }
      const pending = pendingStore.get();
      const draft = pending ?? draftStore.get();
      if (draft) {
        const dx = draft.x2 - draft.x1;
        const dy = draft.y2 - draft.y1;
        drawRuler(
          ctx,
          draft,
          vp,
          formatMeasurement(Math.sqrt(dx * dx + dy * dy), umPerPx, showPx, showUm, showNm),
          false,
        );
      }
    };
    const unsubs = [draftStore.subscribe(draw), pendingStore.subscribe(draw), viewportStore.subscribe(draw)];
    draw();
    return () => unsubs.forEach((unsubscribe) => unsubscribe());
  }, [draftStore, pendingStore, viewportStore, rulers, selectedIds, umPerPx, showPx, showUm, showNm]);

  return <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 20 }} />;
}

export { formatMeasurement };
