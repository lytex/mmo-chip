import { useCallback, useEffect, useRef } from "react";
import type { DieTransform, IOPin, PackagePin, WireBond } from "shared";
import type { PackageGeom } from "../../lib/ic-package/footprinter";
import { transformDiePoint, findNearestPad, findClickedPin } from "../../lib/ic-package/transform";

export interface IcPackageCanvasProps {
  dieImage: HTMLImageElement | null;
  imgW: number;
  imgH: number;
  transform: DieTransform;
  /** Pixels per mm in world coords. */
  pxPerMm: number;
  /** World-origin of the package mm-coordinate system. */
  packageOrigin: { x: number; y: number };
  geom: PackageGeom | null;
  pins: PackagePin[];
  pads: IOPin[];
  bonds: WireBond[];
  bondedPadIds: Set<string>;
  hoveredPadId: string | null;
  selectedPinNumber: number | null;
  tool: "pan" | "name" | "bond";
  /** Bond wire thickness in µm. */
  bondWireWidthUm?: number;
  onViewportChange?: (vp: Viewport) => void;
  onPadHover?: (id: string | null) => void;
  onPinClick?: (num: number) => void;
  onPadClick?: (id: string) => void;
}

interface Viewport {
  ox: number;
  oy: number;
  zoom: number;
}

const BG = "#0c0c08";
const PAD_R = 5;
const PIN_HIT_R = 20;
const PAD_HIT_R = 40;

export function IcPackageCanvas({
  dieImage, imgW, imgH, transform, pxPerMm, packageOrigin,
  geom, pins, pads, bonds, bondedPadIds, hoveredPadId,
  selectedPinNumber, tool, bondWireWidthUm, onViewportChange, onPadHover, onPinClick, onPadClick,
}: IcPackageCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const vpRef = useRef<Viewport>({ ox: 0, oy: 0, zoom: 1 });
  const dragRef = useRef<{ sx: number; sy: number; sox: number; soy: number } | null>(null);

  // ── Resize canvas to match container ────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    const canvas = canvasRef.current;
    if (!el || !canvas) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
    });
    ro.observe(el);
    const r = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    canvas.style.width = `${r.width}px`;
    canvas.style.height = `${r.height}px`;
    return () => ro.disconnect();
  }, []);

  // ── Fit viewport to die + package on first load / change ────────
  const lastFitKey = useRef<string>("");
  useEffect(() => {
    if (!dieImage || !geom) return;
    const key = `${imgW}|${imgH}|${transform.rotationDeg}|${geom.body.minX}`;
    if (lastFitKey.current === key) return;
    lastFitKey.current = key;
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Compute bbox of rotated image.
    const cx = imgW / 2, cy = imgH / 2;
    const rad = (transform.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const mx = transform.mirrorX ? -1 : 1, my = transform.mirrorY ? -1 : 1;
    const pts = [[0, 0], [imgW, 0], [0, imgH], [imgW, imgH]].map(([px, py]) => {
      let x = (px - cx) * mx, y = (py - cy) * my;
      return { x: x * cos - y * sin + cx, y: x * sin + y * cos + cy };
    });
    const ixMin = Math.min(...pts.map((p) => p.x));
    const iyMin = Math.min(...pts.map((p) => p.y));
    const ixMax = Math.max(...pts.map((p) => p.x));
    const iyMax = Math.max(...pts.map((p) => p.y));

    // Union with package outline (in world px).
    const pMinX = packageOrigin.x + geom.body.minX * pxPerMm;
    const pMinY = packageOrigin.y + geom.body.minY * pxPerMm;
    const pMaxX = packageOrigin.x + geom.body.maxX * pxPerMm;
    const pMaxY = packageOrigin.y + geom.body.maxY * pxPerMm;
    const minX = Math.min(ixMin, pMinX);
    const minY = Math.min(iyMin, pMinY);
    const maxX = Math.max(ixMax, pMaxX);
    const maxY = Math.max(iyMax, pMaxY);
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const cw = canvas.clientWidth || 800;
    const ch = canvas.clientHeight || 600;
    const zoom = Math.min(cw / bw, ch / bh) * 0.92;
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;
    vpRef.current = { ox: midX - cw / 2 / zoom, oy: midY - ch / 2 / zoom, zoom };
    onViewportChange?.(vpRef.current);
    canvas.dispatchEvent(new Event("redraw"));
  }, [dieImage, imgW, imgH, transform.rotationDeg, geom, pxPerMm, packageOrigin, onViewportChange]);

  // ── Screen ↔ world helpers ──────────────────────────────────────
  const screenToWorld = useCallback((sx: number, sy: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cx = (sx - rect.left) * dpr;
    const cy = (sy - rect.top) * dpr;
    const vp = vpRef.current;
    return { x: cx / (vp.zoom * dpr) + vp.ox, y: cy / (vp.zoom * dpr) + vp.oy };
  }, []);

  // ── Gesture handlers ────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const vp = vpRef.current;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const mx = ((e.clientX - rect.left) * dpr) / (vp.zoom * dpr);
      const my = ((e.clientY - rect.top) * dpr) / (vp.zoom * dpr);
      const wx = mx + vp.ox;
      const wy = my + vp.oy;
      const factor = Math.exp(-e.deltaY * 0.002);
      const newZoom = Math.max(1e-6, vp.zoom * factor);
      const nmx = ((e.clientX - rect.left) * dpr) / (newZoom * dpr);
      const nmy = ((e.clientY - rect.top) * dpr) / (newZoom * dpr);
      vpRef.current = { ox: wx - nmx, oy: wy - nmy, zoom: newZoom };
      onViewportChange?.(vpRef.current);
      canvas.dispatchEvent(new Event("redraw"));
    };

    let pointerDownPos: { x: number; y: number } | null = null;
    let movedAfterDown = false;

    const onPointerDown = (e: PointerEvent) => {
      pointerDownPos = { x: e.clientX, y: e.clientY };
      movedAfterDown = false;
      if (e.button === 1 || (e.button === 0 && tool === "pan")) {
        dragRef.current = { sx: e.clientX, sy: e.clientY, sox: vpRef.current.ox, soy: vpRef.current.oy };
        canvas.setPointerCapture(e.pointerId);
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (dragRef.current) {
        const vp = vpRef.current;
        // clientX/Y are CSS px; vp.zoom is CSS px per world unit.
        const dx = (e.clientX - dragRef.current.sx) / vp.zoom;
        const dy = (e.clientY - dragRef.current.sy) / vp.zoom;
        vpRef.current.ox = dragRef.current.sox - dx;
        vpRef.current.oy = dragRef.current.soy - dy;
        movedAfterDown = true;
        onViewportChange?.(vpRef.current);
        canvas.dispatchEvent(new Event("redraw"));
        return;
      }
      // Hover detection for pads (bond tool).
      if (onPadHover && imgW > 0) {
        const wp = screenToWorld(e.clientX, e.clientY);
        const snap = findNearestPad(wp.x, wp.y, pads, imgW, imgH, transform, PAD_HIT_R / (vpRef.current.zoom));
        onPadHover(snap?.id ?? null);
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      const wasDrag = movedAfterDown && pointerDownPos &&
        Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y) > 3;
      dragRef.current = null;
      pointerDownPos = null;

      if (wasDrag) return;
      if (tool === "pan") return;

      const wp = screenToWorld(e.clientX, e.clientY);

      if (tool === "name" && onPinClick && geom) {
        const pinMm = { x: (wp.x - packageOrigin.x) / pxPerMm, y: (wp.y - packageOrigin.y) / pxPerMm };
        const num = findClickedPin(pinMm.x, pinMm.y, pins, 1.5);
        if (num != null) onPinClick(num);
        return;
      }
      if (tool === "bond" && onPinClick && onPadClick && geom) {
        if (selectedPinNumber == null) {
          const pinMm = { x: (wp.x - packageOrigin.x) / pxPerMm, y: (wp.y - packageOrigin.y) / pxPerMm };
          const num = findClickedPin(pinMm.x, pinMm.y, pins, 1.5);
          if (num != null) onPinClick(num);
        } else {
          const snap = findNearestPad(wp.x, wp.y, pads, imgW, imgH, transform, PAD_HIT_R / (vpRef.current.zoom));
          if (snap) onPadClick(snap.id);
        }
      }
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);

    return () => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
    };
  }, [tool, onViewportChange, onPadHover, onPinClick, onPadClick, selectedPinNumber, pads, imgW, imgH, transform, pxPerMm, packageOrigin, geom]);

  // ── Draw loop ───────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let rafId: number;
    let dirty = true;

    const markDirty = () => { dirty = true; };
    canvas.addEventListener("redraw", markDirty);
    // rAF is throttled/suspended while the tab is hidden; when we come back
    // the canvas may have been cleared and dirty is false, so nothing
    // repaints until an interaction. Redraw as soon as the page is visible.
    const onVisibility = () => { if (document.visibilityState === "visible") markDirty(); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", markDirty);

    const draw = () => {
      rafId = requestAnimationFrame(draw);
      if (!dirty) return;
      dirty = false;

      const dpr = window.devicePixelRatio || 1;
      const vp = vpRef.current;
      const cw = canvas.width;
      const ch = canvas.height;

      // Clear with identity transform.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, cw, ch);

      if (!dieImage) return;

      // World → screen transform.
      ctx.setTransform(vp.zoom * dpr, 0, 0, vp.zoom * dpr, -vp.ox * vp.zoom * dpr, -vp.oy * vp.zoom * dpr);

      // Draw die image with rotation.
      ctx.save();
      if (transform.rotationDeg !== 0 || transform.mirrorX || transform.mirrorY) {
        ctx.translate(imgW / 2, imgH / 2);
        ctx.rotate((transform.rotationDeg * Math.PI) / 180);
        ctx.scale(transform.mirrorX ? -1 : 1, transform.mirrorY ? -1 : 1);
        ctx.translate(-imgW / 2, -imgH / 2);
      }
      ctx.drawImage(dieImage, 0, 0, imgW, imgH);
      ctx.restore();

      // Package outline.
      if (geom) {
        drawPackageOutline(ctx, geom, pins, packageOrigin, pxPerMm, selectedPinNumber, vp.zoom * dpr);
      }

      // Die pad markers.
      drawPadMarkers(ctx, pads, imgW, imgH, transform, bondedPadIds, hoveredPadId, vp.zoom * dpr);

      // Wire bonds.
      drawBonds(ctx, bonds, pins, pads, imgW, imgH, transform, pxPerMm, packageOrigin, vp.zoom * dpr, bondWireWidthUm);
    };

    rafId = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(rafId);
      canvas.removeEventListener("redraw", markDirty);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", markDirty);
    };
  }, [dieImage, imgW, imgH, transform, pxPerMm, packageOrigin, geom, pins, pads, bonds, bondedPadIds, hoveredPadId, selectedPinNumber, bondWireWidthUm]);

  return (
    <div ref={containerRef} style={{ flex: "1 1 auto", position: "relative", minWidth: 0, background: BG }}>
      <canvas ref={canvasRef} style={{ display: "block" }} />
    </div>
  );
}

// ── Drawing helpers ─────────────────────────────────────────────

export function drawPackageOutline(
  ctx: CanvasRenderingContext2D, geom: PackageGeom,
  pins: PackagePin[],
  origin: { x: number; y: number }, pxPerMm: number,
  selectedPin: number | null, scale: number, light?: boolean,
) {
  const { minX, minY, maxX, maxY } = geom.body;
  const ox = origin.x, oy = origin.y;
  ctx.save();
  ctx.fillStyle = light ? "rgba(228,228,228,0.55)" : "rgba(200,200,200,0.06)";
  ctx.strokeStyle = light ? "rgba(105,105,105,0.9)" : "rgba(160,160,160,0.7)";
  ctx.lineWidth = 2 / scale;
  ctx.beginPath();
  ctx.rect(ox + minX * pxPerMm, oy + minY * pxPerMm, (maxX - minX) * pxPerMm, (maxY - minY) * pxPerMm);
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  for (const pin of pins) {
    const cx = ox + pin.x * pxPerMm;
    const cy = oy + pin.y * pxPerMm;
    const w = pin.w * pxPerMm;
    const h = pin.h * pxPerMm;
    const isSel = pin.number === selectedPin;
    ctx.save();
    ctx.fillStyle = isSel
      ? (light ? "rgba(0,180,90,0.6)" : "rgba(0,200,100,0.6)")
      : (light ? "rgba(150,135,72,0.85)" : "rgba(160,130,60,0.5)");
    ctx.strokeStyle = isSel
      ? (light ? "rgba(0,130,60,1)" : "rgba(0,200,100,1)")
      : (light ? "rgba(95,80,45,1)" : "rgba(120,100,50,1)");
    ctx.lineWidth = 1.5 / scale;
    ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
    ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
    ctx.restore();

    // Number chip + name.
    const numText = `${pin.number}`;
    const fs = Math.max(10, 13 / scale);
    ctx.save();
    ctx.font = `bold ${fs}px ui-monospace, monospace`;
    const m = ctx.measureText(numText);
    const chipW = m.width + 6 / scale;
    const chipH = fs + 4 / scale;
    const chipX = cx + w / 2 + 4 / scale;
    const chipY = cy - chipH / 2;
    ctx.fillStyle = light ? "rgba(255,255,255,0.95)" : "rgba(40,30,10,0.92)";
    ctx.strokeStyle = light ? "rgba(125,125,125,0.95)" : "rgba(255,200,80,0.95)";
    ctx.lineWidth = 1 / scale;
    ctx.beginPath();
    ctx.roundRect(chipX, chipY, chipW, chipH, 3 / scale);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = light ? "rgba(40,40,40,1)" : "rgba(255,230,120,1)";
    ctx.textBaseline = "middle";
    ctx.fillText(numText, chipX + 3 / scale, chipY + chipH / 2);

    // Pin name: bold text centred directly on the pad, sized to the pad's
    // HEIGHT (the true pad dimension) so it stays proportional to the real
    // pad instead of ballooning for wide flat pads. Vertical pads (tall and
    // thin, e.g. QFP/QFN side pins) get the text rotated to read along the
    // pad instead of spilling sideways.
    if (pin.name) {
      // Base the size on the pad's SHORT axis: for a horizontal pad that is
      // pin.h, for a tall vertical pad it is pin.w. Using "height" alone
      // ballooned vertical-pin text because their h is the long dimension.
      const nfs = Math.max(2, Math.min(pin.w, pin.h) * pxPerMm * 0.35);
      const vertical = pin.h > pin.w;
      ctx.save();
      ctx.translate(cx, cy);
      if (vertical) ctx.rotate(-Math.PI / 2);
      ctx.font = `bold ${nfs}px ui-monospace, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.strokeStyle = light ? "rgba(255,255,255,1)" : "rgba(0,0,0,1)";
      ctx.lineWidth = Math.max(0.8, nfs * 0.14);
      ctx.lineJoin = "round";
      ctx.strokeText(pin.name, 0, 0);
      ctx.fillStyle = light ? "rgba(0,0,0,1)" : "rgba(255,255,255,1)";
      ctx.fillText(pin.name, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }
}

export function drawPadMarkers(
  ctx: CanvasRenderingContext2D, pads: IOPin[],
  imgW: number, imgH: number, t: DieTransform,
  bondedIds: Set<string>, hoveredId: string | null, scale: number,
  light?: boolean,
) {
  const r = PAD_R / scale;
  ctx.save();
  ctx.lineWidth = 1.5 / scale;
  for (const pad of pads) {
    const p = transformDiePoint(pad.x, pad.y, imgW, imgH, t);
    const bonded = bondedIds.has(pad.id);
    const hov = hoveredId === pad.id;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = bonded
      ? (light ? "rgba(0,160,70,0.9)" : "rgba(0,200,100,0.85)")
      : hov
        ? (light ? "rgba(222,180,40,0.95)" : "rgba(255,220,80,0.85)")
        : (light ? "rgba(210,70,60,0.9)" : "rgba(255,80,80,0.7)");
    ctx.strokeStyle = bonded
      ? (light ? "rgba(0,90,40,1)" : "rgba(0,60,30,1)")
      : hov
        ? (light ? "rgba(130,90,0,1)" : "rgba(120,80,0,1)")
        : (light ? "rgba(140,40,35,1)" : "rgba(120,30,30,1)");
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

export function drawBonds(
  ctx: CanvasRenderingContext2D, bonds: WireBond[],
  pins: PackagePin[], pads: IOPin[],
  imgW: number, imgH: number, t: DieTransform,
  pxPerMm: number, origin: { x: number; y: number }, scale: number,
  wireWidthUm?: number, light?: boolean,
) {
  const pinMap = new Map(pins.map((p) => [p.number, p]));
  const padMap = new Map(pads.map((p) => [p.id, p]));
  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = light ? "rgba(0,110,210,0.9)" : "rgba(0,180,220,0.9)";
  // Physical wire thickness in world units: µm → mm → world px.
  const wireWorld = ((wireWidthUm ?? 30) / 1000) * pxPerMm;
  ctx.lineWidth = Math.max(1.5 / scale, wireWorld);
  for (const b of bonds) {
    const pin = pinMap.get(b.pinNumber);
    const pad = padMap.get(b.diePadId);
    if (!pin || !pad) continue;
    const a = { x: origin.x + pin.x * pxPerMm, y: origin.y + pin.y * pxPerMm };
    const z = transformDiePoint(pad.x, pad.y, imgW, imgH, t);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(z.x, z.y);
    ctx.stroke();
  }
  ctx.restore();
}
