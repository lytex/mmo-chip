/**
 * FloorplanOverlay.tsx — Renders floorplan region outlines on the canvas
 * as positioned HTML divs.
 *
 * Popover opens on double-click on the body, or single-click on the label.
 * This leaves single-click free for cell/wire drawing on the canvas.
 */

import { useCallback, useMemo } from "react";
import type { DieAnnotations, FloorplanRegion } from "shared";
import type { LiveValue } from "../../lib/liveValue";
import { useLiveValue } from "../../lib/liveValue";
import { useFloorplanStore } from "../../state/floorplan";
import { usePreferences } from "../../state/preferences";
import type { Viewport } from "../../renderer/types";
import { FloorplanRegionPopover } from "./FloorplanRegionPopover";

interface Props {
  annotations: DieAnnotations | undefined;
  viewportStore: LiveValue<Viewport | null>;
  dieId: string;
  /** When true, show port dot markers on all region blocks */
  showIO?: boolean;
  /** Called when annotations have changed (to trigger a refetch). */
  onAnnotationChange?: () => void;
}

const FLOORPLAN_STROKE_WIDTH = 2.2;
const FLOORPLAN_DRAFT_STROKE_WIDTH = 2.2;

/**
 * Renders floorplan region outlines + popover.
 * - Single-click on label → opens popover
 * - Double-click on region body → opens popover
 * - Single-click on body → passes through to canvas (no interception)
 */
export function FloorplanOverlay({
  annotations,
  viewportStore,
  dieId,
  showIO,
  onAnnotationChange,
}: Props) {
  const viewport = useLiveValue(viewportStore);
  const regions = useFloorplanStore((s) => s.regions);
  const selectedRegionId = useFloorplanStore((s) => s.selectedRegionId);
  const selectRegion = useFloorplanStore((s) => s.selectRegion);
  const draft = useFloorplanStore((s) => s.draft);
  const floorplanGloballyHidden = usePreferences((s) => s.hiddenKinds.includes("floorplan"));
  const hiddenFloorplanTypeNames = usePreferences((s) => s.hiddenFloorplanTypeNames);
  const isRegionVisible = useCallback(
    (region: FloorplanRegion) => {
      const override = hiddenFloorplanTypeNames[region.name || "(unnamed)"];
      return override === undefined ? !floorplanGloballyHidden : !override;
    },
    [floorplanGloballyHidden, hiddenFloorplanTypeNames]
  );

  const openPopover = useCallback(
    (region: FloorplanRegion) => {
      selectRegion(region.id);
    },
    [selectRegion],
  );

  const handlePopoverClose = useCallback(() => {
    selectRegion(null);
  }, [selectRegion]);

  // Build rendered items from saved regions + draft
  const renderedRegions = useMemo(() => {
    if (!viewport) return [];
    const items: { region: FloorplanRegion; cssLeft: number; cssTop: number; cssW: number; cssH: number; isDraft: boolean }[] = [];

    for (const r of regions) {
      if (!isRegionVisible(r)) continue;
      const pts = r.geometry;
      const minX = Math.min(...pts.map((p) => p.x));
      const minY = Math.min(...pts.map((p) => p.y));
      const maxX = Math.max(...pts.map((p) => p.x));
      const maxY = Math.max(...pts.map((p) => p.y));
      items.push({
        region: r,
        cssLeft: (minX - viewport.originX) * viewport.zoom,
        cssTop: (minY - viewport.originY) * viewport.zoom,
        cssW: (maxX - minX) * viewport.zoom,
        cssH: (maxY - minY) * viewport.zoom,
        isDraft: false,
      });
    }

    // Draft (in-progress rect drag or poly)
    if (draft && draft.active && draft.points.length >= 2) {
      const pts = draft.points;
      const minX = Math.min(...pts.map((p) => p.x));
      const minY = Math.min(...pts.map((p) => p.y));
      const maxX = Math.max(...pts.map((p) => p.x));
      const maxY = Math.max(...pts.map((p) => p.y));
      items.push({
        region: {
          id: "__draft__",
          name: "",
          kind: draft.kind,
          geometry: pts,
          color: "#aaa",
          createdBy: null,
          createdByName: null,
          createdAt: null,
          reservedBy: null,
          reservedByName: null,
          reservedAt: null,
          portAliases: undefined,
        } as FloorplanRegion,
        cssLeft: (minX - viewport.originX) * viewport.zoom,
        cssTop: (minY - viewport.originY) * viewport.zoom,
        cssW: (maxX - minX) * viewport.zoom,
        cssH: (maxY - minY) * viewport.zoom,
        isDraft: true,
      });
    }

    return items;
  }, [regions, draft, viewport, isRegionVisible]);

  // Selected region for popover
  const selectedRegion = selectedRegionId
    ? regions.find((r) => r.id === selectedRegionId) ?? null
    : null;

  // ── Port visualization ──────────────────────────────────
  // Shows port dots on region blocks.
  //   — Always shows dots for the selected (popover) region
  //   — When showIO is enabled, shows dots for ALL regions
  //   — When showIO is off and no region selected, nothing shows
  // Uses annotation-node proximity detection (find first node inside region polygon).
  const portDots = useMemo(() => {
    if (!annotations || !viewport) return null;

    const regionsToRender: FloorplanRegion[] = [];
    if (showIO) {
      regionsToRender.push(...regions);
    } else if (selectedRegion) {
      regionsToRender.push(selectedRegion);
    }
    if (regionsToRender.length === 0) return null;

    const nets = annotations.nets ?? [];
    const result: { x: number; y: number; color: string; label: string; key: string }[] = [];

    for (const region of regionsToRender) {
      const poly =
        region.kind === "rect" && region.geometry.length >= 2
          ? [
              { x: Math.min(region.geometry[0].x, region.geometry[1].x), y: Math.min(region.geometry[0].y, region.geometry[1].y) },
              { x: Math.max(region.geometry[0].x, region.geometry[1].x), y: Math.min(region.geometry[0].y, region.geometry[1].y) },
              { x: Math.max(region.geometry[0].x, region.geometry[1].x), y: Math.max(region.geometry[0].y, region.geometry[1].y) },
              { x: Math.min(region.geometry[0].x, region.geometry[1].x), y: Math.max(region.geometry[0].y, region.geometry[1].y) },
            ]
          : region.geometry;

      const pointInPoly = (px: number, py: number) => {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const xi = poly[i].x, yi = poly[i].y;
          const xj = poly[j].x, yj = poly[j].y;
          if ((yi > py) !== (yj > py) &&
              px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
            inside = !inside;
          }
        }
        return inside;
      };

      const color = region.color || "#4dabf7";

      for (const net of nets) {
        if (!net.name || net.name === "vcc" || net.name === "gnd" ||
            net.name === "VDD" || net.name === "GND" || net.name === "VSS") continue;
        const firstInsideNode = net.nodes.find((n) => pointInPoly(n.x, n.y));
        if (firstInsideNode) {
          // Dedup: same (region, net, position) should not repeat
          const key = `${region.id}_${net.id}_${firstInsideNode.x.toFixed(1)}_${firstInsideNode.y.toFixed(1)}`;
          if (!result.some((d) => d.key === key)) {
            result.push({ x: firstInsideNode.x, y: firstInsideNode.y, color, label: net.name, key });
          }
        }
      }
    }

    return result.length > 0 ? result : null;
  }, [selectedRegion, annotations, viewport, showIO, regions]);

  return (
    <>
      {/* Region outlines */}
      {renderedRegions.map(({ region, cssLeft, cssTop, cssW, cssH, isDraft }) => {
        const isSelected = region.id === selectedRegionId;
        const color = region.color || "#4dabf7";
        const sw = isDraft ? FLOORPLAN_DRAFT_STROKE_WIDTH : FLOORPLAN_STROKE_WIDTH;

        // Accept both "poly" (legacy) and "polygon" for polygon regions
        const isPoly = (region.kind as string) === "poly" || region.kind === "polygon";
        if (isPoly) {
          // SVG polygon for poly regions
          // Polygon: double-click opens popover; single-click passes through.
          // Text label: single-click opens popover.
          return (
            <svg
              key={region.id}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: "100%",
                pointerEvents: "none",
                zIndex: 8,
              }}
            >
              <polygon
                points={
                  viewport
                    ? region.geometry
                        .map((p) => {
                          const px = (p.x - viewport.originX) * viewport.zoom;
                          const py = (p.y - viewport.originY) * viewport.zoom;
                          return `${px},${py}`;
                        })
                        .join(" ")
                    : ""
                }
                fill="none"
                stroke={isSelected ? "#fff" : color}
                strokeWidth={isDraft ? sw : sw * 1.3}
                strokeDasharray={isDraft ? "5 4" : "7 4"}
                opacity={isDraft ? 0.6 : 1}
                style={{ pointerEvents: "auto", cursor: "pointer" }}
                onDoubleClick={() => !isDraft && openPopover(region)}
              />
              {/* Label — single-click opens popover */}
              {region.name && !isDraft && viewport && (
                <text
                  x={(region.geometry[0].x - viewport.originX) * viewport.zoom + 8}
                  y={(region.geometry[0].y - viewport.originY) * viewport.zoom + 18}
                  fill={color}
                  fontSize={Math.max(13, 14 * viewport.zoom / 1000)}
                  fontWeight="600"
                  style={{ pointerEvents: "auto", cursor: "pointer", textShadow: "0 0 4px rgba(0,0,0,0.7)" }}
                  onClick={() => !isDraft && openPopover(region)}
                >
                  {region.name}
                </text>
              )}
              {/* Draft vertex dots */}
              {isDraft && viewport && (region.geometry as any).length > 0 && (
                (region.geometry as { x: number; y: number }[]).map((p, i) => (
                  <circle
                    key={i}
                    cx={(p.x - viewport.originX) * viewport.zoom}
                    cy={(p.y - viewport.originY) * viewport.zoom}
                    r={3}
                    fill="#fff"
                    stroke="#888"
                    strokeWidth={1.5}
                  />
                ))
              )}
            </svg>
          );
        }

        // Rect region: SVG rect with fill="none" so only the border
        // line catches events — interior passes through to canvas.
        // Double-click on rect → opens popover.
        // Single-click on text label → opens popover.
        // This mirrors the poly region SVG approach.
        return (
          <svg
            key={region.id}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              height: "100%",
              pointerEvents: "none",
              zIndex: 8,
            }}
          >
            <rect
              x={cssLeft}
              y={cssTop}
              width={Math.max(0, cssW)}
              height={Math.max(0, cssH)}
              fill="none"
              stroke={isSelected ? "#fff" : color}
              strokeWidth={sw}
              strokeDasharray={isDraft ? "5 4" : "7 4"}
              rx={3}
              ry={3}
              opacity={isDraft ? 0.6 : 1}
              style={{ pointerEvents: isDraft ? "none" : "auto", cursor: "pointer" }}
              onDoubleClick={() => !isDraft && openPopover(region)}
            />
            {/* Label — clickable on single-click */}
            {region.name && !isDraft && (
              <text
                x={cssLeft + 6}
                y={cssTop + 16}
                fill={color}
                fontSize={Math.max(13, 14 * viewport!.zoom / 1000)}
                fontWeight="600"
                style={{ pointerEvents: "auto", cursor: "pointer", textShadow: "0 0 4px rgba(0,0,0,0.8)" }}
                onClick={() => openPopover(region)}
              >
                {region.name}
              </text>
            )}
            {/* Draft size readout */}
            {isDraft && (
              <text
                x={cssLeft + cssW - 4}
                y={cssTop + cssH - 4}
                fill="#aaa"
                fontSize={11}
                textAnchor="end"
                style={{ pointerEvents: "none", textShadow: "0 0 3px rgba(0,0,0,0.8)" }}
              >
                {Math.round(cssW)} × {Math.round(cssH)}
              </text>
            )}
          </svg>
        );
      })}

      {/* Popover */}
      {selectedRegion && viewport && (
        <FloorplanRegionPopover
          region={selectedRegion}
          dieId={dieId}
          viewport={viewport}
          annotations={annotations}
          onClose={handlePopoverClose}
          onSaved={onAnnotationChange}
        />
      )}

      {/* Port dots */}
      {portDots && viewport && (
        <svg
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            pointerEvents: "none",
            zIndex: 9,
          }}
        >
          {portDots.map((dot) => (
            <g key={dot.key}>
              <circle
                cx={(dot.x - viewport.originX) * viewport.zoom}
                cy={(dot.y - viewport.originY) * viewport.zoom}
                r={5}
                fill={dot.color}
                fillOpacity={0.8}
                stroke="#fff"
                strokeWidth={1.5}
              />
              <text
                x={(dot.x - viewport.originX) * viewport.zoom + 8}
                y={(dot.y - viewport.originY) * viewport.zoom + 4}
                fill={dot.color}
                fontSize={Math.max(10, 13 * viewport.zoom / 1000)}
                fontWeight="600"
                style={{ textShadow: "0 0 4px rgba(0,0,0,0.9)" }}
              >
                {dot.label}
              </text>
            </g>
          ))}
        </svg>
      )}
    </>
  );
}
