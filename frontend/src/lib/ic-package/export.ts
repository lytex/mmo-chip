import type { DieTransform, IOPin, PackagePin, WireBond } from "shared";
import type { PackageGeom } from "./footprinter";
import { drawPackageOutline, drawPadMarkers, drawBonds } from "../../components/ic-package/IcPackageCanvas";

export interface ExportScene {
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
  /** Bond wire thickness in µm. */
  bondWireWidthUm?: number;
  /** Max edge of the export bitmap in px. */
  maxEdge?: number;
}

/**
 * Renders the pin-planner scene to an offscreen canvas with a WHITE
 * background and document-friendly colours, then downloads it as a PNG.
 */
export function exportPinPlannerPng(scene: ExportScene): void {
  const { dieImage, imgW, imgH, transform, pxPerMm, packageOrigin, geom, pins, pads, bonds, bondedPadIds } = scene;
  const maxEdge = scene.maxEdge ?? 1800;
  const light = true;
  const wireWidthUm = scene.bondWireWidthUm;

  // Scene bbox in world coords: rotated image corners + package outline.
  const cx = imgW / 2, cy = imgH / 2;
  const rad = (transform.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const mx = transform.mirrorX ? -1 : 1, my = transform.mirrorY ? -1 : 1;
  const pts = [[0, 0], [imgW, 0], [0, imgH], [imgW, imgH]].map(([px, py]) => {
    const x = (px - cx) * mx, y = (py - cy) * my;
    return { x: x * cos - y * sin + cx, y: x * sin + y * cos + cy };
  });
  let minX = Math.min(...pts.map((p) => p.x));
  let minY = Math.min(...pts.map((p) => p.y));
  let maxX = Math.max(...pts.map((p) => p.x));
  let maxY = Math.max(...pts.map((p) => p.y));
  if (geom) {
    minX = Math.min(minX, packageOrigin.x + geom.body.minX * pxPerMm);
    minY = Math.min(minY, packageOrigin.y + geom.body.minY * pxPerMm);
    maxX = Math.max(maxX, packageOrigin.x + geom.body.maxX * pxPerMm);
    maxY = Math.max(maxY, packageOrigin.y + geom.body.maxY * pxPerMm);
  }
  const margin = (maxX - minX) * 0.03 || 20;
  minX -= margin; minY -= margin; maxX += margin; maxY += margin;
  const worldW = Math.max(1, maxX - minX);
  const worldH = Math.max(1, maxY - minY);

  const scale = maxEdge / Math.max(worldW, worldH);
  const cw = Math.max(1, Math.round(worldW * scale));
  const ch = Math.max(1, Math.round(worldH * scale));

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cw, ch);

  // World → bitmap transform.
  ctx.setTransform(scale, 0, 0, scale, -minX * scale, -minY * scale);

  // Die image (rotated/mirrored exactly like the live view).
  if (dieImage) {
    ctx.save();
    if (transform.rotationDeg !== 0 || transform.mirrorX || transform.mirrorY) {
      ctx.translate(imgW / 2, imgH / 2);
      ctx.rotate((transform.rotationDeg * Math.PI) / 180);
      ctx.scale(transform.mirrorX ? -1 : 1, transform.mirrorY ? -1 : 1);
      ctx.translate(-imgW / 2, -imgH / 2);
    }
    ctx.drawImage(dieImage, 0, 0, imgW, imgH);
    ctx.restore();
  }

  if (geom) {
    drawPackageOutline(ctx, geom, pins, packageOrigin, pxPerMm, null, scale, light);
  }
  drawPadMarkers(ctx, pads, imgW, imgH, transform, bondedPadIds, null, scale, light);
  drawBonds(ctx, bonds, pins, pads, imgW, imgH, transform, pxPerMm, packageOrigin, scale, wireWidthUm, light);

  const url = canvas.toDataURL("image/png");
  triggerDownload(url, "pin-planner.png");
}

export interface PinTableRow {
  number: number;
  name: string;
  diePadNumbers: number[];
  diePadNames: string[];
}

/** Pin table derived from package pins + bonds + die pads. */
export function buildPinTable(
  pins: PackagePin[],
  bonds: WireBond[],
  pads: IOPin[],
): PinTableRow[] {
  const padById = new Map(pads.map((p) => [p.id, p]));
  return pins.map((p) => {
    const bs = bonds.filter((b) => b.pinNumber === p.number);
    const diePadNumbers: number[] = [];
    const diePadNames: string[] = [];
    for (const b of bs) {
      const pad = padById.get(b.diePadId);
      if (pad) {
        diePadNumbers.push(pad.pin);
        if (pad.name) diePadNames.push(pad.name);
      }
    }
    return { number: p.number, name: p.name, diePadNumbers, diePadNames };
  });
}

/** Downloads the pin table as UTF-8 CSV (BOM so Excel opens it correctly). */
export function exportPinTableCsv(rows: PinTableRow[]): void {
  const header = ["Pin #", "Pin name", "Die pad #s", "Die pad names"];
  const lines = rows.map((r) => [
    String(r.number),
    r.name,
    r.diePadNumbers.map((n) => `#${n}`).join("; "),
    r.diePadNames.join("; "),
  ]);
  const csv = [header, ...lines]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, "pin-table.csv");
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function triggerDownload(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}