import type { Guide } from "shared";
import {
  distancePointToSegment,
  normalizeRect,
  segmentIntersectsRect,
  type Point,
  type Rect
} from "./geometry";

/** Distance (world units) from a point to a guide's geometry. */
function distanceToGuide(g: Guide, p: Point): number {
  if (g.kind === "line") {
    return g.axis === "x" ? Math.abs(p.x - g.pos) : Math.abs(p.y - g.pos);
  }
  return distancePointToSegment(p, { x: g.x1, y: g.y1 }, { x: g.x2, y: g.y2 });
}

/** Nearest guide within `tol` of `p`, or null. */
export function guideHitTest(
  guides: Guide[],
  p: Point,
  tol: number
): Guide | null {
  let best: Guide | null = null;
  let bestD = tol;
  for (const g of guides) {
    const d = distanceToGuide(g, p);
    if (d <= bestD) {
      best = g;
      bestD = d;
    }
  }
  return best;
}

/** Guides that intersect a (world) marquee rect. */
export function guidesInRect(guides: Guide[], r: Rect, fullyContained = false): Guide[] {
  const n = normalizeRect(r);
  return guides.filter((g) => {
    if (g.kind === "line") {
      return g.axis === "x"
        ? g.pos >= n.x && g.pos <= n.x + n.width
        : g.pos >= n.y && g.pos <= n.y + n.height;
    }
    if (fullyContained) {
      return (
        g.x1 >= n.x && g.x1 <= n.x + n.width &&
        g.x2 >= n.x && g.x2 <= n.x + n.width &&
        g.y1 >= n.y && g.y1 <= n.y + n.height &&
        g.y2 >= n.y && g.y2 <= n.y + n.height
      );
    }
    return segmentIntersectsRect(
      { x: g.x1, y: g.y1 },
      { x: g.x2, y: g.y2 },
      n
    );
  });
}

/**
 * True when `p` lies inside the region spanned by `guides` (so a drag started
 * *between* selected guides grabs the group). Each axis is only constrained if
 * some guide bounds it — two vertical lines bound x only, so any y between
 * their x-positions counts.
 */
export function pointInGuidesRegion(
  guides: Guide[],
  p: Point,
  tol: number
): boolean {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let xB = false;
  let yB = false;
  for (const g of guides) {
    if (g.kind === "line") {
      if (g.axis === "x") {
        xB = true;
        minX = Math.min(minX, g.pos);
        maxX = Math.max(maxX, g.pos);
      } else {
        yB = true;
        minY = Math.min(minY, g.pos);
        maxY = Math.max(maxY, g.pos);
      }
    } else {
      xB = true;
      yB = true;
      minX = Math.min(minX, g.x1, g.x2);
      maxX = Math.max(maxX, g.x1, g.x2);
      minY = Math.min(minY, g.y1, g.y2);
      maxY = Math.max(maxY, g.y1, g.y2);
    }
  }
  if (!xB && !yB) return false;
  const okX = !xB || (p.x >= minX - tol && p.x <= maxX + tol);
  const okY = !yB || (p.y >= minY - tol && p.y <= maxY + tol);
  return okX && okY;
}

/** Translate a guide by (dx, dy), rounded. Lines only shift on their axis. */
export function translateGuide(g: Guide, dx: number, dy: number): Guide {
  if (g.kind === "line") {
    return { ...g, pos: Math.round(g.pos + (g.axis === "x" ? dx : dy)) };
  }
  return {
    ...g,
    x1: Math.round(g.x1 + dx),
    y1: Math.round(g.y1 + dy),
    x2: Math.round(g.x2 + dx),
    y2: Math.round(g.y2 + dy)
  };
}

/** Nearest candidate within `tol` of `v`, or `v` unchanged. */
function snap(v: number, candidates: number[], tol: number): number {
  let best = v;
  let bestD = tol;
  for (const c of candidates) {
    const d = Math.abs(c - v);
    if (d <= bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/**
 * Snap a rect's four edges to nearby guides (within `tol`, world units).
 * Infinite `line` guides always apply on their axis; finite `segment` guides
 * only apply when the rect's perpendicular span overlaps the segment (so a
 * short segment guide doesn't grab a far-away cell). Edges snap independently;
 * a snap that would collapse an axis is skipped.
 */
export function snapRectToGuides(
  rect: Rect,
  guides: Guide[],
  tol: number
): Rect {
  const n = normalizeRect(rect);
  const left = n.x;
  const right = n.x + n.width;
  const top = n.y;
  const bottom = n.y + n.height;

  const vx: number[] = []; // vertical guide x-coords (snap left/right)
  const hy: number[] = []; // horizontal guide y-coords (snap top/bottom)

  for (const g of guides) {
    if (g.kind === "line") {
      if (g.axis === "x") vx.push(g.pos);
      else hy.push(g.pos);
      continue;
    }
    // segment: axis-aligned by construction.
    if (g.x1 === g.x2) {
      const lo = Math.min(g.y1, g.y2) - tol;
      const hi = Math.max(g.y1, g.y2) + tol;
      if (bottom >= lo && top <= hi) vx.push(g.x1);
    } else if (g.y1 === g.y2) {
      const lo = Math.min(g.x1, g.x2) - tol;
      const hi = Math.max(g.x1, g.x2) + tol;
      if (right >= lo && left <= hi) hy.push(g.y1);
    }
  }

  let l = snap(left, vx, tol);
  let r = snap(right, vx, tol);
  let t = snap(top, hy, tol);
  let b = snap(bottom, hy, tol);
  if (r - l < 1) {
    l = left;
    r = right;
  }
  if (b - t < 1) {
    t = top;
    b = bottom;
  }
  return { x: l, y: t, width: r - l, height: b - t };
}
