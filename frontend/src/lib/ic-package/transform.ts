import type { DieTransform, PackagePin } from "shared";

/** A axis-aligned rectangle. */
export interface Bbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Bounding box of the source image after applying the given rotation (deg).
 *  Mirrors are ignored here — they don't change the bbox. The returned box is
 *  centered on the original image center; for 0°/180° it coincides with the
 *  source [0,w]×[0,h]; for 90°/270° the dimensions swap and the box shifts so
 *  its center stays put (which means it can extend past the original bounds
 *  for rectangular dies — caller must account for this). */
export function rotatedImageBbox(w: number, h: number, deg: number): Bbox {
  if (deg === 0 || deg === 180) {
    return { x: 0, y: 0, width: w, height: h };
  }
  // 90° / 270°: rotated image is h × w, still centered on (w/2, h/2).
  const cx = w / 2;
  const cy = h / 2;
  return {
    x: cx - h / 2,
    y: cy - w / 2,
    width: h,
    height: w,
  };
}

/** Apply rotation + mirror to a point in die-image pixel coordinates,
 *  returning the new pixel coordinates. The image is treated as anchored
 *  at its center, which matches how DieImageLayer positions it.
 *  Rotation is in degrees (0/90/180/270) and is applied AFTER mirror.
 *  Mirror/rotation are inverted vs the canvas because we are mapping
 *  source pixels → display pixels under the inverse transform. */
export function transformDiePoint(
  px: number,
  py: number,
  imgW: number,
  imgH: number,
  t: DieTransform
): { x: number; y: number } {
  let x = px - imgW / 2;
  let y = py - imgH / 2;
  if (t.mirrorX) x = -x;
  if (t.mirrorY) y = -y;
  switch (t.rotationDeg) {
    case 90:
      [x, y] = [-y, x];
      break;
    case 180:
      [x, y] = [-x, -y];
      break;
    case 270:
      [x, y] = [y, -x];
      break;
  }
  return { x: x + imgW / 2, y: y + imgH / 2 };
}

/** Inverse — given a click in display (transformed) coordinates, where
 *  was the point in the source image? Used for hit-testing pads. */
export function inverseTransformDiePoint(
  dx: number,
  dy: number,
  imgW: number,
  imgH: number,
  t: DieTransform
): { x: number; y: number } {
  let x = dx - imgW / 2;
  let y = dy - imgH / 2;
  switch (t.rotationDeg) {
    case 90:
      [x, y] = [y, -x];
      break;
    case 180:
      [x, y] = [-x, -y];
      break;
    case 270:
      [x, y] = [-y, x];
      break;
  }
  if (t.mirrorX) x = -x;
  if (t.mirrorY) y = -y;
  return { x: x + imgW / 2, y: y + imgH / 2 };
}

/** Nearest-pad snap in display coordinates. Pads live in source coords;
 *  we transform each one and compare against the click. */
export function findNearestPad<T extends { id: string; x: number; y: number }>(
  clickX: number,
  clickY: number,
  pads: T[],
  imgW: number,
  imgH: number,
  t: DieTransform,
  maxDistPx: number
): { id: string; dist: number } | null {
  let best: { id: string; dist: number } | null = null;
  for (const pad of pads) {
    const p = transformDiePoint(pad.x, pad.y, imgW, imgH, t);
    const d = Math.hypot(p.x - clickX, p.y - clickY);
    if (d <= maxDistPx && (!best || d < best.dist)) {
      best = { id: pad.id, dist: d };
    }
  }
  return best;
}

/** Hit-test a package pin given a click in world coordinates (mm). */
export function findClickedPin(
  clickX: number,
  clickY: number,
  pins: PackagePin[],
  maxDistMm: number
): number | null {
  let best: { num: number; dist: number } | null = null;
  for (const p of pins) {
    const d = Math.hypot(p.x - clickX, p.y - clickY);
    if (d <= maxDistMm && (!best || d < best.dist)) {
      best = { num: p.number, dist: d };
    }
  }
  return best?.num ?? null;
}

/** Defaults. */
export const DEFAULT_DIE_TRANSFORM: DieTransform = {
  rotationDeg: 0,
  mirrorX: false,
  mirrorY: false,
};
