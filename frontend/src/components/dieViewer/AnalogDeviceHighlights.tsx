/**
 * AnalogDeviceHighlightsLayer.ts — Device highlighting overlay on die viewer.
 *
 * Renders detected analog devices (NPNS, MOS, resistors, capacitors, diodes)
 * as coloured bounding boxes with instance names (Q1, M1, R1…) over the die
 * image. Supports click-to-inspect via onDeviceClick callback.
 *
 * Architecture:
 *   - Takes the list of devices from collectDieWideAnalogDevices()
 *   - Renders as a lightweight canvas overlay (not full AnnotationLayer)
 *   - Each device gets a colour by kind + label
 *   - Click resolves which device was hit and fires onDeviceClick
 */

import { useEffect, useRef } from "react";
import type { AnalogDevice } from "shared";
import type { LiveValue } from "../../lib/liveValue";
import { useLiveValue } from "../../lib/liveValue";
import type { Viewport } from "../../renderer/types";
import { usePreferences } from "../../state/preferences";
import { effectiveCapacitance } from "../../lib/export/capacitorDefaults";

// ── Colour palette per device kind ───────────────────────────────

const DEVICE_COLORS: Record<string, string> = {
  bjt_npn: "#44ff66",   // green — NPN
  bjt_pnp: "#66ff88",   // lighter green — PNP
  mos: "#4488ff",       // blue — MOS
  resistor: "#ffaa44",  // orange — resistor
  capacitor: "#44ddff", // cyan — capacitor
  diode: "#ff6666",     // red — diode
  jfet_n: "#88ffaa",    // light green — N-JFET
  jfet_p: "#44ffaa",    // seafoam — P-JFET
  unknown: "#888888",   // grey
};

const DEVICE_FILL: Record<string, string> = {
  bjt_npn: "rgba(68, 255, 102, 0.12)",
  bjt_pnp: "rgba(102, 255, 136, 0.12)",
  mos: "rgba(68, 136, 255, 0.12)",
  resistor: "rgba(255, 170, 68, 0.12)",
  capacitor: "rgba(68, 221, 255, 0.12)",
  diode: "rgba(255, 102, 102, 0.12)",
  jfet_n: "rgba(136, 255, 170, 0.12)",
  jfet_p: "rgba(68, 255, 170, 0.12)",
  unknown: "rgba(136, 136, 136, 0.10)",
};

// ── Component ─────────────────────────────────────────────────────

interface Props {
  /** All analog devices to highlight, in die-world coordinates. */
  devices: AnalogDevice[];
  /** Live viewport — the component subscribes internally so it only
   *  re-renders when the viewport actually changes, not on every parent
   *  render. */
  viewportStore: LiveValue<Viewport | null>;
  /** Called when the user clicks on a device. */
  onDeviceClick?: (device: AnalogDevice) => void;
  /** Called when the user double-clicks a device (e.g. to open in RE Cell). */
  onDeviceDoubleClick?: (device: AnalogDevice) => void;
  /** Show net IDs next to terminal labels. */
  showNetIds?: boolean;
  /** numeric netId → human-readable net name (e.g. "n100", "VCC"). */
  netNames?: Map<number, string>;
  /** Show cell relationship status (Linked ×N / Unique) on device labels. */
  showCellRelations?: boolean;
  /** cellTypeId → number of instances sharing that type. */
  cellTypeCounts?: Map<string, number>;
  /** cellId → cellTypeId lookup. */
  cellTypeByCellId?: Map<string, string>;
}

/** Minimum device bbox area (world px²) to bother drawing the label. */
const MIN_LABEL_AREA = 200;
/** Below this zoom level, hide terminal-point labels (G, S/D, E/C/B…). */
const TERM_LABEL_MIN_ZOOM = 0.7;
/** Below this zoom level, hide the parameter-hint line. */
const PARAM_MIN_ZOOM = 0.5;

export function AnalogDeviceHighlights({
  devices,
  viewportStore,
  onDeviceClick,
  onDeviceDoubleClick,
  showNetIds,
  netNames,
  showCellRelations,
  cellTypeCounts,
  cellTypeByCellId,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The capacitance of a capacitor comes from its plate area ×
  // the specific capacitance, so the label follows the setting.
  const capDensity = usePreferences((s) => s.capDensity);
  const viewport = useLiveValue(viewportStore);

  // Drawing: the viewport is read inside the effect via a ref, so the effect
  // doesn't need to re-bind on every viewport change — the ResizeObserver +
  // viewport subscription drives the rAF loop.
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const showNetIdsRef = useRef(showNetIds);
  showNetIdsRef.current = showNetIds;
  const showCellRelationsRef = useRef(showCellRelations);
  showCellRelationsRef.current = showCellRelations;
  const cellTypeCountsRef = useRef(cellTypeCounts);
  cellTypeCountsRef.current = cellTypeCounts;
  const cellTypeByCellIdRef = useRef(cellTypeByCellId);
  cellTypeByCellIdRef.current = cellTypeByCellId;

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let lastSlowLog = 0;

    const draw = () => {
      raf = 0;
      const vp = viewportRef.current;
      if (!vp) return;
      const t0 = performance.now();

      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);

      // Group devices by bbox to handle multi-finger MOS (M4, M5 share bbox)
      const groups = new Map<string, AnalogDevice[]>();
      for (const dev of devices) {
        const b = dev.bbox;
        if (!b) continue;
        const key = `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)},${Math.round(b.height)}`;
        const list = groups.get(key) ?? [];
        list.push(dev);
        groups.set(key, list);
      }

      for (const [, group] of groups) {
        const dev = group[0]; // primary device (first in group)
        const bbox = dev.bbox;
        if (!bbox) continue;

        const sx = (bbox.x - vp.originX) * vp.zoom;
        const sy = (bbox.y - vp.originY) * vp.zoom;
        const sw = bbox.width * vp.zoom;
        const sh = bbox.height * vp.zoom;

        // Skip off-screen
        if (sx + sw < -50 || sx > rect.width + 50) continue;
        if (sy + sh < -50 || sy > rect.height + 50) continue;

        const color = DEVICE_COLORS[dev.kind] ?? DEVICE_COLORS.unknown;
        const fill = DEVICE_FILL[dev.kind] ?? DEVICE_FILL.unknown;

        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.fillStyle = fill;
        ctx.strokeRect(sx, sy, sw, sh);
        ctx.fillRect(sx, sy, sw, sh);

        // Label — combine all instance names for devices sharing the bbox
        const area = sw * sh;
        if (area >= MIN_LABEL_AREA) {
          const names = group.map((d) => d.instanceName ?? d.id).join(" ");
          const typeStr = deviceTypeString(dev);
          let labelFull = typeStr ? `${names} ${typeStr}` : names;
          // Append cell relationship status if enabled
          const ctByCell = cellTypeByCellIdRef.current;
          const ctCounts = cellTypeCountsRef.current;
          if (showCellRelationsRef.current && ctByCell && ctCounts) {
            const cellId = (dev as any)._cellId as string | undefined;
            if (cellId) {
              const ctId = ctByCell.get(cellId);
              if (ctId) {
                const count = ctCounts.get(ctId) ?? 1;
                labelFull += count > 1 ? ` ×${count}` : " ◆";
              }
            }
          }
          ctx.font = `600 ${Math.max(10, Math.min(14, sw * 0.18))}px monospace`;
          const textMetrics = ctx.measureText(labelFull);
          const labelW = textMetrics.width + 8;
          const labelH = 18;
          const labelBX = sx + 2;
          const labelBY = sy + 2;

          ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
          ctx.fillRect(labelBX, labelBY, labelW, labelH);
          ctx.fillStyle = color;
          ctx.textBaseline = "middle";
          ctx.fillText(labelFull, labelBX + 4, labelBY + labelH / 2);

          // Parameter hint from first device
          const paramStr = paramHint(dev, capDensity);
          if (paramStr && sw > 120 && vp.zoom >= PARAM_MIN_ZOOM) {
            ctx.font = `400 ${Math.max(9, Math.min(13, sw * 0.14))}px monospace`;
            ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
            ctx.textBaseline = "top";
            ctx.fillText(paramStr, labelBX + 4, labelBY + labelH + 3);
          }
        }

        // Terminal labels for ALL devices in this group (each per-gate MOS
        // has its own _termPoints with distinct netIds).
        for (const d of group) {
          drawTerminalLabels(ctx, d, vp, showNetIdsRef.current, netNames);
        }
      }

      // Slow-draw probe: this overlay repaints EVERY device on screen per
      // frame (own canvas, full clear + redraw). At far zoom-outs the whole
      // die's device set is visible, so text measurement + label fills can
      // outrun the frame budget and visibly lag behind the base image —
      // the log names the size of the set, rate-limited to 2 s.
      const drawMs = performance.now() - t0;
      if (drawMs > 16 && performance.now() - lastSlowLog > 2000) {
        lastSlowLog = performance.now();
        console.info(
          `[perf] analog devices overlay drew ${groups.size} bbox groups in ${drawMs.toFixed(0)}ms`
        );
      }
    };

    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(draw);
    };

    draw();
    const ro = new ResizeObserver(schedule);
    ro.observe(canvas);
    const unsubVp = viewportStore.subscribe(schedule);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      unsubVp();
    };
  }, [devices, viewportStore, showNetIds, capDensity]);

  // ── Click / double-click handling ───────────────────────────
  // Tracks click timing for double-click detection (300ms threshold).
  const lastClickRef = useRef<{ time: number; device: AnalogDevice } | null>(null);

  const hitTest = (e: React.MouseEvent<HTMLCanvasElement>): AnalogDevice | null => {
    const vp = viewportRef.current;
    if (!vp) return null;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const clickX = (e.clientX - rect.left) / vp.zoom + vp.originX;
    const clickY = (e.clientY - rect.top) / vp.zoom + vp.originY;

    let best: AnalogDevice | null = null;
    let bestArea = Infinity;
    for (const dev of devices) {
      const b = dev.bbox;
      if (!b) continue;
      if (clickX >= b.x && clickX <= b.x + b.width &&
          clickY >= b.y && clickY <= b.y + b.height) {
        const area = b.width * b.height;
        if (area < bestArea) {
          bestArea = area;
          best = dev;
        }
      }
    }
    return best;
  };

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const dev = hitTest(e);
    if (!dev) return;

    // Double-click detection: two clicks on same device within 300ms
    const last = lastClickRef.current;
    const now = Date.now();
    if (last && last.device === dev && now - last.time < 300) {
      lastClickRef.current = null;
      onDeviceDoubleClick?.(dev);
      return;
    }

    lastClickRef.current = { time: now, device: dev };
    onDeviceClick?.(dev);
  };

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    />
  );
}

// ── Device type labels & parameter hints ────────────────────────

/** Human-readable device type for overlay label. */
function deviceTypeString(dev: AnalogDevice): string {
  const g = dev.geometry as any;
  switch (dev.kind) {
    case "mos":
      return (g.mosType as string) === "pmos" ? "pmos" : "nmos";
    case "bjt_npn":
      return "npn";
    case "bjt_pnp":
      return "pnp";
    case "resistor": {
      const t = g.resistorType as string | undefined;
      if (t === "poly") return "poly res";
      if (t === "hsr") return "hsr res";
      if (t === "pb") return "pb res";
      if (t === "npl") return "npl res";
      if (t === "film") return "film res";
      return "res";
    }
    case "capacitor":
      return "cap";
    case "diode":
      return "diode";
    default:
      return dev.kind;
  }
}

function paramHint(dev: AnalogDevice, capDensity: number): string {
  const g = dev.geometry;
  switch (dev.kind) {
    case "mos": {
      if ("L_um" in g && "W_um" in g) {
        const mg = g as { L_um: number; W_um: number; fingers?: number; multiplier?: number };
        const parts = [`W=${mg.W_um.toFixed(1)}u`, `L=${mg.L_um.toFixed(2)}u`];
        if (mg.fingers && mg.fingers > 1) parts.push(`F=${mg.fingers}`);
        if (mg.multiplier && mg.multiplier > 1) parts.push(`M=${mg.multiplier}`);
        return parts.join(" ");
      }
      return "";
    }
    case "bjt_npn":
    case "bjt_pnp": {
      if ("PE_um" in g && dev.kind === "bjt_pnp") {
        const bg = g as { PE_um: number; multiplier?: number };
        const pe = bg.PE_um;
        if (pe > 0) return `PE=${pe.toFixed(1)}µm`;
      }
      if ("AE_um2" in g) {
        const bg = g as { AE_um2: number; multiplier?: number };
        const ae = bg.AE_um2;
        const m = bg.multiplier && bg.multiplier > 1 ? `×${bg.multiplier}` : "";
        return `AE=${ae.toFixed(2)}µm²${m}`;
      }
      return "";
    }
    case "resistor": {
      if ("squares" in g) {
        const rg = g as { squares: number; resistance_ohms?: number; resistorType?: string };
        const typeTag = rg.resistorType ? rg.resistorType.toUpperCase() : "POLY";
        return `${typeTag} □${rg.squares.toFixed(1)}`;
      }
      return "";
    }
    case "capacitor": {
      if ("capacitance_fF" in g) {
        const cg = g as { area_um2?: number; capacitance_fF?: number };
        const cFf = effectiveCapacitance(cg, capDensity);
        if (cFf) return `${cFf.toFixed(2)}fF`;
      }
      return "";
    }
    default:
      return "";
  }
}

// ── Terminal label rendering ─────────────────────────────────────

/** Draw terminal labels at actual layer-shape positions. One label per
 *  shape — so a BJT with two base contacts gets two "B" labels.
 *  All same-name labels share one net (handled by the extractor). */
function drawTerminalLabels(
  ctx: CanvasRenderingContext2D,
  dev: AnalogDevice & { _termPoints?: Array<{x:number;y:number;name:string}>; _dsResolved?: boolean },
  vp: { originX: number; originY: number; zoom: number },
  showNetIds?: boolean,
  netNames?: Map<number, string>,
): void {
  // Don't draw terminal labels when zoomed far out — would clutter the view.
  if (vp.zoom < TERM_LABEL_MIN_ZOOM) return;
  const points = (dev as any)._termPoints as Array<{x:number;y:number;name:string}> | undefined;
  if (!points || points.length === 0) return;

  const color = DEVICE_COLORS[dev.kind] ?? DEVICE_COLORS.unknown;
  const fontSize = 9;
  ctx.font = `600 ${fontSize}px monospace`;
  ctx.textBaseline = "middle";

  for (const pt of points) {
    const sx = (pt.x - vp.originX) * vp.zoom;
    const sy = (pt.y - vp.originY) * vp.zoom;

    // Resolve terminal netId (always — needed for unconnected glow)
    const term = dev.terminals.find((t) => t.name === pt.name);
    const netId = term?.netId;

// ── Unconnected terminal glow ──
if (netId !== undefined && netId >= 2000) {
  ctx.save();
  
  // Настройка базовой тени
  ctx.shadowColor = "rgb(255, 0, 0)";
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;

  // Шаг 1: Рисуем первый слой с большим размытием (широкий ореол)
  ctx.shadowBlur = 28;
  ctx.beginPath();
  ctx.arc(sx + 5, sy, 8, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255, 0, 0, 1)";
  ctx.fill();

  // Шаг 2: Рисуем второй слой с меньшим размытием (плотное свечение у центра)
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.arc(sx + 5, sy, 8, 0, Math.PI * 2);
  ctx.fill();

  // Шаг 3: Рисуем само ядро (белое или светло-розовое) БЕЗ тени, чтобы оно не размывалось
  ctx.shadowColor = "transparent"; // Отключаем тень для ядра
  ctx.beginPath();
  ctx.arc(sx + 5, sy, 6, 0, Math.PI * 2); // Чуть меньше радиус
  ctx.fillStyle = "#ff000057"; // Центр
  ctx.fill();

  ctx.restore();
}

    // Relabel D/S: if resolved (force SOURCE or bulk heuristic), show actual name.
    // Otherwise show "S/D" for both (MOS is symmetric by default).
    const dsResolved = (dev as any)._dsResolved === true;
    const displayName = pt.name === "D" || pt.name === "S"
      ? (dsResolved ? pt.name : "S/D")
      : pt.name;
    // Build label: optionally show net name
    const netLabel = showNetIds && netId !== undefined && netNames?.has(netId)
      ? netNames.get(netId)!
      : showNetIds && netId !== undefined ? String(netId) : undefined;
    const label = netLabel !== undefined ? `${displayName}:${netLabel}` : displayName;
    const tm = ctx.measureText(label);
    const tw = tm.width + 4;
    const th = fontSize + 4;

    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(sx + 4, sy - th / 2, tw, th);
    ctx.fillStyle = color;
    ctx.fillText(label, sx + 6, sy);
  }
}
