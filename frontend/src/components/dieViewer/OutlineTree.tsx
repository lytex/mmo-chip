import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DieAnnotations } from "shared";
import { Ic } from "../../icons";
import { useToast } from "../Toast";
import { useOverlayLayers } from "../../state/overlayLayers";
import { useSession, DEFAULT_METAL_STACK, buildMetalStack, fetchMetalStack } from "../../state/session";
import { apiPut, apiUpload } from "../../api/client";
import {
  CELL_COLOR_OPTIONS,
  NET_COLOR_OPTIONS,
  NET_MAX_WIDTH,
  NET_MIN_WIDTH
} from "../../renderer/annotations/dieAnnotations";
import {
  VIA_COLOR_OPTIONS,
  VIA_DEFAULT_COLOR,
  VIA_MAX_SIZE,
  VIA_MIN_SIZE,
  WIRE_LAYER_COLOR,
  NET_NODE_RADIUS_MULT
} from "../../renderer/annotations/style";
import { ColorSwatches, SettingsPopover } from "./SettingsPopover";
import {
  ANNOTATION_KIND_VALUES,
  type AnnotationKind
} from "../../state/annotationKinds";
import { useDieViewerStore } from "../../state/dieViewer";
import { usePreferences } from "../../state/preferences";
import { TreeRow, TreeSep } from "../tree/TreeRow";

// Re-export so existing imports keep working.
export { ANNOTATION_KIND_VALUES as ANNOTATION_KINDS };
export type { AnnotationKind };

type Props = {
  annotations: DieAnnotations | undefined;
  /** Frame these annotation ids in the viewport — fired on row double-click. */
  onFocus?: (ids: string[]) => void;
  /** Base (die background) images. One per die today; the data model will
   *  grow to multiple later. Each gets independent visibility + opacity. */
  baseImages?: { id: string; name: string }[];
  /** cell ID → device name (Q1, R1 etc.) from analog extraction */
  deviceLabels?: Map<string, string>;
  /** Fired on double-click of a cell with a device label. */
  onDeviceSelect?: (cellId: string) => void;
  /** Navigate to the RE Cell tab for this cell. */
  onOpenInRE?: (cellId: string, cellTypeId: string) => void;
  /** Mutable ref — parent can set .current to a function that opens search. */
  searchOpenRef?: React.MutableRefObject<(() => void) | null>;
};

/** Session-group key for the "ML Regions" parent (it spans two annotation
 *  kinds, so it can't key off a single AnnotationKind like other sections). */
const ML_REGIONS_KEY = "ml-regions";
const ML_KINDS: AnnotationKind[] = ["roi", "ignore"];
/** Session-group key for the "ML Results" section (live ML predictions —
 *  fetched per tile, not persisted, so not an AnnotationKind). */
const ML_RESULTS_KEY = "ml-results";
/** Session-group key for the "Guides" section (not an AnnotationKind — guides
 *  render via their own overlay, not the rbush layer). */
const GUIDES_KEY = "guides";
/** Session-group key for the "Base Images" section (die background images;
 *  not an AnnotationKind — they render via the image layer, not rbush). */
const BASE_IMAGES_KEY = "base-images";
/** Session-group key for the "Overlay Layers" section. */
const OVERLAY_LAYERS_KEY = "overlay-layers";

export function OutlineTree({ annotations, onFocus, baseImages = [], deviceLabels, onDeviceSelect, onOpenInRE, searchOpenRef }: Props) {
  const toast = useToast();
  const expandedSections = usePreferences((s) => s.expandedSections);
  const hiddenKinds = usePreferences((s) => s.hiddenKinds);
  const toggleSection = usePreferences((s) => s.toggleSectionExpanded);
  const toggleKindVisibility = usePreferences((s) => s.toggleKindVisibility);

  const guidesHidden = usePreferences((s) => s.guidesHidden);
  const setGuidesHidden = usePreferences((s) => s.setGuidesHidden);
  const guidesLocked = usePreferences((s) => s.guidesLocked);
  const setGuidesLocked = usePreferences((s) => s.setGuidesLocked);

  const baseImageHidden = usePreferences((s) => s.baseImageHidden);
  const setBaseImageHidden = usePreferences((s) => s.setBaseImageHidden);
  const baseGlobalVisible = useOverlayLayers((s) => s.baseImageVisible);

  const mlResultsHidden = usePreferences((s) => s.mlResultsHidden);
  const setMlResultsHidden = usePreferences((s) => s.setMlResultsHidden);

  // Read per-net color overrides once (not inside the .map, hooks rules).
  const netColors = usePreferences((s) => s.netColors);
  const globalNetColor = usePreferences((s) => s.netColor);
  const setNetColorOverride = usePreferences((s) => s.setNetColorOverride);
  const setNetColorsForIds = usePreferences((s) => s.setNetColorsForIds);

  const selectedIds = useDieViewerStore((s) => s.selectedIds);
  const select = useDieViewerStore((s) => s.select);
  const expandedGroups = useDieViewerStore((s) => s.expandedGroups);
  const toggleGroup = useDieViewerStore((s) => s.toggleGroup);
  const mlViasCount = useDieViewerStore((s) => s.mlViasCount);

  // Whole-net ids present in the current selection — includes nets selected
  // by clicking a sub-part (edge/node id like "net:abc/edge:1") on the canvas,
  // so a canvas marquee/shift-click selection can drive the bulk color picker
  // too, not just multi-select in this list.
  const selectedNetIds = useMemo(() => {
    const ids = new Set<string>();
    for (const id of selectedIds) {
      if (!id.startsWith("net:")) continue;
      const netId = id.split("/")[0];
      ids.add(netId);
    }
    return Array.from(ids);
  }, [selectedIds]);

  // Overlay layers (user-loaded images).
  const overlayLayers = useOverlayLayers((s) => s.layers);
  const addLayer = useOverlayLayers((s) => s.addLayer);
  const addTiledLayer = useOverlayLayers((s) => s.addTiledLayer);
  const setLayerHidden = useOverlayLayers((s) => s.setLayerHidden);
  const moveLayer = useOverlayLayers((s) => s.moveLayer);
  const [draggedOverlayIndex, setDraggedOverlayIndex] = useState<number | null>(null);

  const localFileInputRef = useRef<HTMLInputElement>(null);
  const serverFileInputRef = useRef<HTMLInputElement>(null);

  // ── Search ──────────────────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Expose toggleSearch() to parent via ref.
  useEffect(() => {
    if (searchOpenRef) {
      searchOpenRef.current = () => {
        setSearchOpen((prev) => {
          if (prev) {
            // Already open → close.
            setSearchQuery("");
            return false;
          }
          // Closed → open and focus.
          setTimeout(() => searchInputRef.current?.focus(), 0);
          return true;
        });
      };
    }
    return () => { if (searchOpenRef) searchOpenRef.current = null; };
  }, [searchOpenRef]);

  const q = searchQuery.toLowerCase().trim();
  const matchNet = useCallback((name: string) => !q || name.toLowerCase().includes(q), [q]);
  const matchCell = useCallback((name: string) => !q || name.toLowerCase().includes(q), [q]);

  const dieId = useSession((s) => s.dieId);
  const [uploadingLegacy, setUploadingLegacy] = useState(false);
  const onLocalFilePick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || !dieId) return;
      setUploadingLegacy(true);
      const tasks = Array.from(files).map(async (file) => {
        try {
          const mod = await import("../../api/overlayImages");
          const uploaded = await mod.uploadOverlayImage(dieId, file);
          addTiledLayer(uploaded.image);
        } catch (err) {
          toast.error(`Failed to upload ${file.name}`, (err as Error).message);
        }
      });
      Promise.allSettled(tasks).then(() => setUploadingLegacy(false));
      e.target.value = "";
    },
    [addTiledLayer, dieId]
  );
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const onUploadToServer = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || !dieId) return;
      setUploadingFiles(true);
      const tasks = Array.from(files).map(async (file) => {
        try {
          const mod = await import("../../api/overlayImages");
          const uploaded = await mod.uploadOverlayImage(dieId, file);
          addTiledLayer(uploaded.image);
        } catch (err) {
          toast.error(`Failed to upload ${file.name}`, (err as Error).message);
        }
      });
      Promise.allSettled(tasks).then(() => setUploadingFiles(false));
      e.target.value = "";
    },
    [addTiledLayer, dieId]
  );
  const [loadingTestImages, setLoadingTestImages] = useState(false);
  const onLoadFromServer = useCallback(() => {
    if (!dieId || loadingTestImages) return;
    setLoadingTestImages(true);
    import("../../api/overlayImages")
      .then(async (mod) => {
        const list = await mod.fetchOverlayImageList(dieId);
        const results = await Promise.allSettled(
          list.images.map((img) => mod.loadOverlayImageFromServer(dieId, img.name))
        );
        for (const result of results) {
          if (result.status === "fulfilled") {
            addLayer(result.value.name, result.value.image, undefined, result.value.serverFilename);
          }
        }
        setLoadingTestImages(false);
      })
      .catch(() => setLoadingTestImages(false));
  }, [addLayer, dieId, loadingTestImages]);

  const cellsByType = useMemo(() => groupCellsByType(annotations), [annotations]);
  const viaTotals = useMemo(() => viaCounts(annotations), [annotations]);

  if (!annotations) {
    return (
      <div
        className="m"
        style={{
          padding: "12px 10px",
          color: "var(--ink3)",
          fontSize: 10.5
        }}
      >
        loading annotations…
      </div>
    );
  }

  const isOpen = (k: AnnotationKind) => expandedSections.includes(k);
  const visibilityFor = (k: AnnotationKind) => ({
    visible: !hiddenKinds.includes(k),
    onToggle: () => toggleKindVisibility(k)
  });

  // "ML Regions" is one collapsible parent over both ML kinds. Its eye toggles
  // ROIs + ignore-rects together (no independent per-subcategory hiding).
  const mlOpen = expandedGroups.includes(ML_REGIONS_KEY);
  const mlResultsOpen = expandedGroups.includes(ML_RESULTS_KEY);
  const guidesOpen = expandedGroups.includes(GUIDES_KEY);
  const baseImagesOpen = expandedGroups.includes(BASE_IMAGES_KEY);
  const overlayLayersOpen = expandedGroups.includes(OVERLAY_LAYERS_KEY);
  const mlAnyVisible = ML_KINDS.some((k) => !hiddenKinds.includes(k));
  const mlVisibility = {
    visible: mlAnyVisible,
    onToggle: () => {
      const target = !mlAnyVisible;
      for (const k of ML_KINDS) {
        if (!hiddenKinds.includes(k) !== target) toggleKindVisibility(k);
      }
    }
  };

  // Annotation ids per category, for double-click "frame in viewport". Cheap
  // to recompute; double-click is rare.
  const netIdsAll = annotations.nets.map((n) => `net:${n.id}`);
  const cellIdsAll = annotations.cells.map((c) => `cell:${c.id}`);
  const anns = annotations.annotations ?? [];
  const pointViaIds = anns
    .filter((a) => a.class === "point_via")
    .map((a) => `anno:${a.id}`);
  const irregularViaIds = anns
    .filter((a) => a.class === "irregular_via")
    .map((a) => `anno:${a.id}`);
  const viaIdsAll = [...pointViaIds, ...irregularViaIds];
  const pinIdsAll = (annotations.pins ?? []).map((p) => `pin:${p.id}`);
  const roiIdsAll = (annotations.rois ?? []).map((r) => `roi:${r.id}`);
  const ignoreIdsAll = (annotations.ignores ?? []).map((r) => `ignore:${r.id}`);
  const focus = (ids: string[]) => {
    if (ids.length) onFocus?.(ids);
  };

  // Filtered lists for search.
  const filteredNets = q ? annotations.nets.filter((n) => matchNet(n.name || n.id)) : annotations.nets;
  const filteredCellsByType = q
    ? cellsByType
        .map((g) => ({
          ...g,
          cells: g.cells.filter((c) =>
            matchCell(g.cellType.name || g.cellType.id) ||
            matchCell(deviceLabels?.get(c.id) ?? "") ||
            matchCell(c.id)
          ),
        }))
        .filter((g) => g.cells.length > 0)
    : cellsByType;

  return (
    <div className="tree" style={{ overflow: "auto", flex: "1 1 auto", minHeight: 0 }}>
      {/* Search input ──────────────────────────────────────────────────── */}
      {searchOpen && (
        <div style={{ padding: "4px 8px", borderBottom: "1px solid var(--l2)" }}>
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setSearchQuery("");
                setSearchOpen(false);
              }
              if (e.key === "Enter" && q) {
                // Focus first match.
                const firstNet = filteredNets[0];
                const firstCell = filteredCellsByType[0]?.cells[0];
                if (firstNet) { focus([`net:${firstNet.id}`]); return; }
                if (firstCell) { focus([`cell:${firstCell.id}`]); return; }
              }
            }}
            placeholder="Search nets, cells, pins…"
            autoFocus
            style={{
              width: "100%",
              fontSize: 11,
              padding: "3px 6px",
              background: "var(--bg)",
              color: "var(--ink)",
              border: "1px solid var(--l2)",
              borderRadius: 4,
              outline: "none",
            }}
          />
        </div>
      )}

      {/* Nets ------------------------------------------------------------ */}
      <TreeRow
        expand={isOpen("net") ? "open" : "closed"}
        label="Nets"
        meta={q ? `${filteredNets.length}/${annotations.nets.length}` : annotations.nets.length}
        controls={
          <>
            {selectedNetIds.length >= 2 && (
              <BulkNetColorButton
                count={selectedNetIds.length}
                onPick={(c) => setNetColorsForIds(selectedNetIds, c)}
              />
            )}
            <NetSettingsButton />
          </>
        }
        visibility={visibilityFor("net")}
        onToggleExpand={() => toggleSection("net")}
        onSelect={() => toggleSection("net")}
        onDoubleClick={() => focus(netIdsAll)}
      />
      {isOpen("net") &&
        filteredNets.map((net) => {
          const id = `net:${net.id}`;
          const netColor = netColors[id] ?? globalNetColor;
          return (
            <TreeRow
              key={id}
              depth={1}
              label={net.name || net.id}
              meta={`${net.edges.length} edges`}
              controls={
                <NetColorSettings
                  netId={id}
                  currentColor={netColor}
                  onPick={(c) => setNetColorOverride(id, c)}
                />
              }
              selected={selectedIds.has(id)}
              onSelect={(e) =>
                select([id], e.shiftKey || e.metaKey || e.ctrlKey ? "toggle" : "replace")
              }
              onDoubleClick={() => focus([id])}
            />
          );
        })}

      <TreeSep />

      {/* Cells ----------------------------------------------------------- */}
      <TreeRow
        expand={isOpen("cell") ? "open" : "closed"}
        label="Cells"
        meta={q ? `${filteredCellsByType.reduce((s, g) => s + g.cells.length, 0)}/${annotations.cells.length}` : annotations.cells.length}
        controls={<CellSettingsButton />}
        visibility={visibilityFor("cell")}
        onToggleExpand={() => toggleSection("cell")}
        onSelect={() => toggleSection("cell")}
        onDoubleClick={() => focus(cellIdsAll)}
      />
      {isOpen("cell") &&
        filteredCellsByType.map((group) => {
          const groupKey = `cellType:${group.cellType.id}`;
          const open = expandedGroups.includes(groupKey);
          return (
            <div key={groupKey}>
              <TreeRow
                depth={1}
                expand={open ? "open" : "closed"}
                label={group.cellType.name || group.cellType.id}
                meta={group.cells.length}
                selected={selectedIds.has(groupKey)}
                onToggleExpand={() => toggleGroup(groupKey)}
                onSelect={() => select([groupKey])}
                onDoubleClick={() =>
                  focus(group.cells.map((c) => `cell:${c.id}`))
                }
              />
              {open &&
                group.cells.map((cell) => {
                  const id = `cell:${cell.id}`;
                  return (
                    <TreeRow
                      key={id}
                      depth={2}
                      icon={Ic.cell}
                      monoLabel
                      label={deviceLabels?.get(cell.id) ?? cell.id.slice(0,8)}
                      selected={selectedIds.has(id)}
                      onSelect={() => select([id])}
                      onDoubleClick={() => { focus([id]); const label = deviceLabels?.get(cell.id); if (label && onDeviceSelect) onDeviceSelect(cell.id); }}
                      controls={onOpenInRE ? (
                        <span
                          onClick={(e) => { e.stopPropagation(); onOpenInRE(cell.id, cell.cellTypeId); }}
                          title="Open in RE Cell"
                          style={{
                            display: "inline-flex",
                            cursor: "pointer",
                            color: "var(--ink3)",
                            padding: "1px 3px",
                            borderRadius: 3,
                          }}
                        >
                          {Ic.link}
                        </span>
                      ) : undefined}
                    />
                  );
                })}
            </div>
          );
        })}

      <TreeSep />

      {/* Vias (ML annotations) ------------------------------------------ */}
      <TreeRow
        expand={isOpen("via") ? "open" : "closed"}
        label="Vias"
        meta={viaTotals.total}
        controls={<ViaSettingsButton />}
        visibility={visibilityFor("via")}
        onToggleExpand={() => toggleSection("via")}
        onSelect={() => toggleSection("via")}
        onDoubleClick={() => focus(viaIdsAll)}
      />
      {isOpen("via") && (
        <>
          <TreeRow
            depth={1}
            swatch="rgba(130, 214, 166, 0.85)"
            label="point vias"
            meta={viaTotals.points}
            onDoubleClick={() => focus(pointViaIds)}
          />
          <TreeRow
            depth={1}
            swatch="rgba(130, 214, 166, 0.5)"
            label="irregular vias"
            meta={viaTotals.irregular}
            onDoubleClick={() => focus(irregularViaIds)}
          />
        </>
      )}

      <TreeSep />

      {/* I/O pins -------------------------------------------------------- */}
      <TreeRow
        expand={isOpen("pin") ? "open" : "closed"}
        label="I/O pins"
        meta={annotations.pins?.length ?? 0}
        visibility={visibilityFor("pin")}
        onToggleExpand={() => toggleSection("pin")}
        onSelect={() => toggleSection("pin")}
        onDoubleClick={() => focus(pinIdsAll)}
      />
      {isOpen("pin") &&
        annotations.pins?.map((pin) => {
          const id = `pin:${pin.id}`;
          return (
            <TreeRow
              key={id}
              depth={1}
              icon={Ic.ioPoint}
              label={pin.name || `pin ${pin.pin}`}
              meta={`#${pin.pin}`}
              selected={selectedIds.has(id)}
              onSelect={() => select([id])}
              onDoubleClick={() => focus([id])}
            />
          );
        })}

      <TreeSep />

      {/* ML Regions (ROIs + ignore rects) -------------------------------- */}
      <TreeRow
        expand={mlOpen ? "open" : "closed"}
        label="ML Regions"
        meta={(annotations.rois?.length ?? 0) + (annotations.ignores?.length ?? 0)}
        visibility={mlVisibility}
        onToggleExpand={() => toggleGroup(ML_REGIONS_KEY)}
        onSelect={() => toggleGroup(ML_REGIONS_KEY)}
        onDoubleClick={() => focus([...roiIdsAll, ...ignoreIdsAll])}
      />
      {mlOpen && (
        <>
          <TreeRow
            depth={1}
            expand={isOpen("roi") ? "open" : "closed"}
            label="ML Training ROIs"
            meta={annotations.rois?.length ?? 0}
            onToggleExpand={() => toggleSection("roi")}
            onSelect={() => toggleSection("roi")}
            onDoubleClick={() => focus(roiIdsAll)}
          />
          {isOpen("roi") &&
            annotations.rois?.map((roi, idx) => {
              const id = `roi:${roi.id}`;
              return (
                <TreeRow
                  key={id}
                  depth={2}
                  icon={Ic.roi}
                  label={`ROI · ${idx + 1}`}
                  meta={`${roi.width}×${roi.height}`}
                  selected={selectedIds.has(id)}
                  onSelect={() => select([id])}
                  onDoubleClick={() => focus([id])}
                />
              );
            })}

          <TreeRow
            depth={1}
            expand={isOpen("ignore") ? "open" : "closed"}
            label="Ignore rects"
            meta={annotations.ignores?.length ?? 0}
            onToggleExpand={() => toggleSection("ignore")}
            onSelect={() => toggleSection("ignore")}
            onDoubleClick={() => focus(ignoreIdsAll)}
          />
          {isOpen("ignore") &&
            annotations.ignores?.map((r, idx) => {
              const id = `ignore:${r.id}`;
              return (
                <TreeRow
                  key={id}
                  depth={2}
                  icon={Ic.mlIgnore}
                  label={`region ${idx + 1}`}
                  meta={`${r.width}×${r.height}`}
                  selected={selectedIds.has(id)}
                  onSelect={() => select([id])}
                  onDoubleClick={() => focus([id])}
                />
              );
            })}
        </>
      )}

      <TreeSep />

      {/* ML Results (live predictions, fetched per tile) ----------------- */}
      <TreeRow
        expand={mlResultsOpen ? "open" : "closed"}
        label="ML Results"
        meta={mlViasCount}
        visibility={{
          visible: !mlResultsHidden,
          onToggle: () => setMlResultsHidden(!mlResultsHidden)
        }}
        onToggleExpand={() => toggleGroup(ML_RESULTS_KEY)}
        onSelect={() => toggleGroup(ML_RESULTS_KEY)}
      />
      {mlResultsOpen && (
        <TreeRow
          depth={1}
          swatch="rgba(130, 214, 166, 0.85)"
          label="vias"
          meta={mlViasCount}
        />
      )}

      <TreeSep />

      {/* Cell-grid guides ------------------------------------------------ */}
      <TreeRow
        expand={guidesOpen ? "open" : "closed"}
        label="Guides"
        meta={annotations.guides?.length ?? 0}
        controls={
          <button
            type="button"
            className="trow-eye"
            title={guidesLocked ? "Unlock guides" : "Lock guides"}
            aria-pressed={guidesLocked}
            onClick={() => setGuidesLocked(!guidesLocked)}
            style={{
              display: "inline-flex",
              background: "transparent",
              border: 0,
              padding: 0,
              cursor: "pointer",
              color: guidesLocked ? "var(--accent)" : "var(--ink3)"
            }}
          >
            {Ic.lock}
          </button>
        }
        visibility={{
          visible: !guidesHidden,
          onToggle: () => setGuidesHidden(!guidesHidden)
        }}
        onToggleExpand={() => toggleGroup(GUIDES_KEY)}
        onSelect={() => toggleGroup(GUIDES_KEY)}
      />
      {guidesOpen &&
        annotations.guides?.map((g) => {
          const id = `guide:${g.id}`;
          const label =
            g.kind === "line"
              ? `${g.axis === "x" ? "vertical" : "horizontal"} @ ${g.pos}`
              : `segment (${g.x1},${g.y1})→(${g.x2},${g.y2})`;
          return (
            <TreeRow
              key={id}
              depth={1}
              icon={g.kind === "line" ? Ic.gridLine : Ic.gridSeg}
              label={label}
              dimmed={guidesLocked}
              selected={selectedIds.has(id)}
              onSelect={guidesLocked ? undefined : () => select([id])}
            />
          );
        })}

      <TreeSep />

      {/* Base images ---------------------------------------------------- */}
      <TreeRow
        expand={baseImagesOpen ? "open" : "closed"}
        label="Base Images"
        meta={baseImages.length}
        onToggleExpand={() => toggleGroup(BASE_IMAGES_KEY)}
        onSelect={() => toggleGroup(BASE_IMAGES_KEY)}
      />
      {baseImagesOpen &&
        baseImages.map((img) => {
          const visible = baseImageHidden[img.id] !== true && baseGlobalVisible;
          return (
            <TreeRow
              key={`baseimg:${img.id}`}
              depth={1}
              icon={Ic.image}
              label={img.name || img.id}
              controls={<BaseImageSettings id={img.id} />}
              visibility={{
                visible,
                onToggle: () => setBaseImageHidden(img.id, visible)
              }}
            />
          );
        })}

      <TreeSep />

      {/* Overlay layers (user-loaded images) ---------------------------- */}
      <TreeRow
        expand={overlayLayersOpen ? "open" : "closed"}
        label="Overlay Layers"
        meta={overlayLayers.length}
        onToggleExpand={() => toggleGroup(OVERLAY_LAYERS_KEY)}
        onSelect={() => toggleGroup(OVERLAY_LAYERS_KEY)}
      />
      {overlayLayersOpen && (
        <>
          <TreeRow
            depth={1}
            icon={Ic.upload}
            label={<span style={{ color: "var(--accent)" }}>{uploadingFiles ? "Uploading…" : "Add tiled overlay…"}</span>}
            onSelect={() => serverFileInputRef.current?.click()}
          />
          {/* Quick overlay upload — same endpoint, simpler label. */}
          <TreeRow
            depth={1}
            icon={Ic.plus}
            label={<span style={{ color: "var(--ink2)" }}>{uploadingLegacy ? "Uploading…" : "Add overlay image…"}</span>}
            onSelect={() => localFileInputRef.current?.click()}
          />
          <TreeRow
            depth={1}
            icon={Ic.download}
            label={
              <span style={{ color: "var(--accent)" }}>
                {loadingTestImages ? "Loading…" : "Load from Server…"}
              </span>
            }
            onSelect={onLoadFromServer}
          />
          <input
            ref={serverFileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            style={{ display: "none" }}
            onChange={onUploadToServer}
          />
          <input
            ref={localFileInputRef}
            type="file"
            accept="image/png,image/jpeg"
            multiple
            style={{ display: "none" }}
            onChange={onLocalFilePick}
          />
          {overlayLayers.length === 0 && (
            <div
              style={{
                padding: "6px 10px 6px 20px",
                fontSize: 10,
                color: "var(--ink3)",
                lineHeight: 1.5
              }}
            >
              Load PNG/JPEG/WebP images as semi-transparent overlays on the die
              view. All uploaded images are shared across users. Use visibility
              and opacity to compare layers.
            </div>
          )}
          <div
            style={{
              padding: "4px 10px 6px 20px",
              fontSize: 9,
              color: "var(--ink3)",
              lineHeight: 1.4
            }}
          >
            <strong>Add tiled overlay</strong> uploads an image to the server — available to all users, persists across sessions.
            <strong> Load from Server</strong> picks up images already on disk.
            <strong> Add overlay image</strong> quick upload, same as above.
          </div>
          {overlayLayers.map((layer, index) => (
            <TreeRow
              key={layer.id}
              depth={1}
              icon={Ic.image}
              draggable
              onDragStart={() => setDraggedOverlayIndex(index)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (draggedOverlayIndex != null && draggedOverlayIndex !== index) {
                  moveLayer(draggedOverlayIndex, index);
                }
                setDraggedOverlayIndex(null);
              }}
              onDragEnd={() => setDraggedOverlayIndex(null)}
              label={<OverlayLayerLabel layerId={layer.id} name={layer.name} />}
              controls={
                <OverlayLayerSettings layerId={layer.id} />
              }
              visibility={{
                visible: !layer.hidden,
                onToggle: () =>
                  setLayerHidden(layer.id, !layer.hidden)
              }}
            />
          ))}
        </>
      )}
    </div>
  );
}

/** Per-net color override. Cycles through a small palette. */
const NET_OVERRIDE_COLORS = [
  null,                     // reset to global
  "#ff3333",               // VDD red
  "#3388ff",               // GND blue
  "#22d366",               // VSS green
  "#ffaa00",               // IO yellow
  "#ff66aa",               // pink
  "#aa66ff",               // purple
  "#66ffaa",               // mint
];

/** Tiny color swatch used as the popover trigger for per-net color
 *  override — replaces the generic sliders icon so the coloured square
 *  itself is clickable. */
const SWATCH_TRIGGER = (color: string) => (
  <span
    style={{
      width: 8, height: 8,
      background: color,
      border: "1px solid rgba(0,0,0,0.15)",
      borderRadius: 1,
      flex: "0 0 auto",
      display: "block",
    }}
  />
);

/** Preset swatches + a custom hex color input, shared by the per-net and
 *  bulk (multi-select) color pickers. */
function NetColorPickerBody({ currentColor, onPick }: {
  currentColor: string;
  onPick: (color: string | null) => void;
}) {
  const customColor = /^#[0-9a-f]{6}$/i.test(currentColor) ? currentColor : "#2e97ff";
  return (
    <>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", maxWidth: 140 }}>
        {NET_OVERRIDE_COLORS.map((c, i) => {
          const label = c === null
            ? "default"
            : ["VDD red","GND blue","VSS green","IO yellow","pink","purple","mint"][i - 1] ?? "";
          return (
            <button
              key={i}
              type="button"
              title={label}
              style={{
                width: 24, height: 24, borderRadius: 3,
                border: currentColor === (c ?? "#2e97ff") ? "2px solid rgba(255,255,255,0.9)" : "1px solid rgba(255,255,255,0.2)",
                background: c ?? "#555",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 9,
                color: c ? "rgba(0,0,0,0.3)" : "rgba(255,255,255,0.5)",
              }}
              onClick={() => onPick(c)}
            >
              {c === null ? "↺" : ""}
            </button>
          );
        })}
      </div>
      <div className="row" style={{ gap: 8, marginTop: 10, alignItems: "center" }}>
        <input
          type="color"
          value={customColor}
          onChange={(e) => onPick(e.target.value)}
          title="Pick a custom color"
          style={{
            width: 28, height: 22, padding: 0, cursor: "pointer",
            border: "1px solid var(--l2)", borderRadius: 3, background: "none"
          }}
        />
        <span style={{ fontSize: 10, color: "var(--ink3)" }}>Custom color</span>
      </div>
    </>
  );
}

function NetColorSettings({ netId, currentColor, onPick }: {
  netId: string;
  currentColor: string;
  onPick: (color: string | null) => void;
}) {
  return (
    <SettingsPopover label="Net color" triggerContent={SWATCH_TRIGGER(currentColor)}>
      <div className="u" style={{ marginBottom: 6, fontSize: 10 }}>
        Override color
      </div>
      <NetColorPickerBody currentColor={currentColor} onPick={onPick} />
    </SettingsPopover>
  );
}

/** Multi-select bulk color assign — appears in the Nets section header once
 *  2+ nets are selected (canvas shift-click/marquee or ctrl/cmd-click in this
 *  list). Applies one color persistently to every selected net at once. */
function BulkNetColorButton({ count, onPick }: {
  count: number;
  onPick: (color: string | null) => void;
}) {
  const trigger = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 9, color: "var(--ink2)" }}>
      <span
        style={{
          width: 8, height: 8, borderRadius: 1,
          background: "linear-gradient(135deg, #2e97ff 50%, #ef4444 50%)",
          border: "1px solid rgba(0,0,0,0.15)",
          flex: "0 0 auto"
        }}
      />
      {count}
    </span>
  );
  return (
    <SettingsPopover label={`Color ${count} selected nets`} triggerContent={trigger}>
      <div className="u" style={{ marginBottom: 6, fontSize: 10 }}>
        Color {count} selected nets
      </div>
      <NetColorPickerBody currentColor="" onPick={onPick} />
    </SettingsPopover>
  );
}

/** Per-base-image opacity slider (visibility is the row's eye). */
function BaseImageSettings({ id }: { id: string }) {
  const opacity = usePreferences((s) => s.baseImageOpacity[id] ?? 1);
  const setOpacity = usePreferences((s) => s.setBaseImageOpacity);
  const pct = Math.round(opacity * 100);
  return (
    <SettingsPopover label="Base image settings">
      <div className="u" style={{ marginBottom: 8 }}>
        Opacity
      </div>
      <div className="row" style={{ gap: 10 }}>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={pct}
          onChange={(e) => setOpacity(id, Number(e.target.value) / 100)}
        />
        <span
          className="m"
          style={{
            width: 36,
            color: "var(--ink2)",
            fontSize: 11,
            textAlign: "right"
          }}
        >
          {pct}%
        </span>
      </div>
    </SettingsPopover>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

function groupCellsByType(annotations: DieAnnotations | undefined) {
  if (!annotations) return [];
  const byType = new Map<string, typeof annotations.cells>();
  for (const cell of annotations.cells) {
    const list = byType.get(cell.cellTypeId);
    if (list) list.push(cell);
    else byType.set(cell.cellTypeId, [cell]);
  }
  return annotations.cellTypes
    .map((cellType) => ({ cellType, cells: byType.get(cellType.id) ?? [] }))
    .filter((g) => g.cells.length > 0)
    .sort((a, b) => b.cells.length - a.cells.length);
}

function viaCounts(annotations: DieAnnotations | undefined) {
  let points = 0;
  let irregular = 0;
  for (const a of annotations?.annotations ?? []) {
    if (a.class === "point_via") points++;
    else if (a.class === "irregular_via") irregular++;
  }
  return { points, irregular, total: points + irregular };
}

// ── Settings popovers ───────────────────────────────────────────────

function NetSettingsButton() {
  const width = usePreferences((s) => s.netWidth);
  const setNetWidth = usePreferences((s) => s.setNetWidth);
  const netColor = usePreferences((s) => s.netColor);
  const setNetColor = usePreferences((s) => s.setNetColor);
  const wireLayerColors = usePreferences((s) => s.wireLayerColors);
  const setWireLayerColor = usePreferences((s) => s.setWireLayerColor);
  const viaLayerColors = usePreferences((s) => s.viaLayerColors);
  const setViaLayerColor = usePreferences((s) => s.setViaLayerColor);
  const netNodeSize = usePreferences((s) => s.netNodeSize);
  const setNetNodeSize = usePreferences((s) => s.setNetNodeSize);
  const netNodeVisible = usePreferences((s) => s.netNodeVisible);
  const setNetNodeVisible = usePreferences((s) => s.setNetNodeVisible);
  const customNetColorsEnabled = usePreferences((s) => s.customNetColorsEnabled);
  const setCustomNetColorsEnabled = usePreferences((s) => s.setCustomNetColorsEnabled);
  const metalStack = useSession((s) => s.metalStack ?? DEFAULT_METAL_STACK);

  return (
    <SettingsPopover label="Net settings">
      <div className="u" style={{ marginBottom: 8 }}>
        Net wire width
      </div>
      <div className="row" style={{ gap: 10 }}>
        <input
          type="range"
          min={NET_MIN_WIDTH}
          max={NET_MAX_WIDTH}
          step={0.1}
          value={width}
          onChange={(e) => setNetWidth(Number(e.target.value))}
        />
        <span
          className="m"
          style={{ width: 36, color: "var(--ink2)", fontSize: 11, textAlign: "right" }}
        >
          {width.toFixed(1)}
        </span>
      </div>

      <div className="u" style={{ margin: "12px 0 8px" }}>
        Color mode
      </div>
      <div className="row" style={{ gap: 4 }}>
        <button
          type="button"
          className={"btn sm" + (customNetColorsEnabled ? " on" : "")}
          onClick={() => setCustomNetColorsEnabled(true)}
        >
          By net (custom)
        </button>
        <button
          type="button"
          className={"btn sm" + (!customNetColorsEnabled ? " on" : "")}
          onClick={() => setCustomNetColorsEnabled(false)}
        >
          By metal/silicon type
        </button>
      </div>
      <div style={{ fontSize: 9, color: "var(--ink3)", lineHeight: 1.4, margin: "6px 0 12px" }}>
        {customNetColorsEnabled
          ? "Nets with a custom color below render in that color; others fall back to layer colors."
          : "Custom net colors are hidden — every net renders by its metal/silicon layer color. Your per-net assignments are kept."}
      </div>

      <div className="u" style={{ margin: "12px 0 8px" }}>
        Net wire color
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <ColorSwatches options={NET_COLOR_OPTIONS.slice(0, 8)} value={netColor} onPick={setNetColor} />
        <ColorSwatches options={NET_COLOR_OPTIONS.slice(8)} value={netColor} onPick={setNetColor} />
      </div>

      <div
        style={{
          fontSize: 11, color: "var(--ink3)", letterSpacing: 1,
          display: "flex", alignItems: "center", gap: 8,
          margin: "12px 0 8px",
        }}
      >
        <span className="u">Metal layers</span>
        <select
          style={{
            marginLeft: "auto", fontSize: 10,
            background: "var(--l2)", color: "var(--ink)",
            border: "1px solid var(--l3)", borderRadius: 4,
            padding: "2px 4px",
          }}
          value={metalStack.metals.length}
          onChange={async (e) => {
            const count = Number(e.target.value);
            const stack = buildMetalStack(count);
            const dieId = useSession.getState().dieId;
            if (dieId) {
              await apiPut(`/api/dies/${dieId}/metal-stack`, stack);
              await fetchMetalStack(dieId).then(s => useSession.getState().setMetalStack(s));
            } else {
              useSession.getState().setMetalStack(stack);
            }
          }}
        >
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </div>
      <div className="u" style={{ margin: "12px 0 8px" }}>
        Layer colors
      </div>
      <div>
        {metalStack.metals.map((m) => (
          <div key={m.id} style={{ marginBottom: 12, fontSize: 10 }}>
            <div style={{ color: "var(--ink3)", marginBottom: 6 }}>{m.name}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <ColorSwatches
                options={NET_COLOR_OPTIONS.slice(0, 8)}
                value={wireLayerColors[m.layer] ?? WIRE_LAYER_COLOR[m.layer] ?? m.color}
                onPick={(c) => setWireLayerColor(m.layer, c)}
              />
              <ColorSwatches
                options={NET_COLOR_OPTIONS.slice(8)}
                value={wireLayerColors[m.layer] ?? WIRE_LAYER_COLOR[m.layer] ?? m.color}
                onPick={(c) => setWireLayerColor(m.layer, c)}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="u" style={{ margin: "12px 0 8px" }}>
        Junction dots
      </div>
      <label className="check" style={{ marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={netNodeVisible}
          onChange={(e) => setNetNodeVisible(e.target.checked)}
        />
        Show dots at wire turns
      </label>
      <div className="row" style={{ gap: 10 }}>
        <input
          type="range"
          min={0}
          max={5}
          step={0.1}
          value={netNodeVisible ? netNodeSize : 0}
          disabled={!netNodeVisible}
          onChange={(e) => setNetNodeSize(Number(e.target.value))}
        />
        <span
          className="m"
          style={{ width: 36, color: "var(--ink2)", fontSize: 11, textAlign: "right" }}
        >
          {netNodeVisible ? netNodeSize.toFixed(1) : "—"}
        </span>
      </div>
    </SettingsPopover>
  );
}

function ViaSettingsButton() {
  const viaSize = usePreferences((s) => s.viaSize);
  const setViaSize = usePreferences((s) => s.setViaSize);
  const viaColor = usePreferences((s) => s.viaColor);
  const setViaColor = usePreferences((s) => s.setViaColor);
  const viaLayerColors = usePreferences((s) => s.viaLayerColors);
  const setViaLayerColor = usePreferences((s) => s.setViaLayerColor);
  const vias = (useSession((s) => s.metalStack) ?? DEFAULT_METAL_STACK).vias;
  return (
    <SettingsPopover label="Via settings">
      <div className="u" style={{ marginBottom: 8 }}>
        Via radius
      </div>
      <div className="row" style={{ gap: 10 }}>
        <input
          type="range"
          min={VIA_MIN_SIZE}
          max={VIA_MAX_SIZE}
          step={0.5}
          value={viaSize}
          onChange={(e) => setViaSize(Number(e.target.value))}
        />
        <span
          className="m"
          style={{ width: 36, color: "var(--ink2)", fontSize: 11, textAlign: "right" }}
        >
          {viaSize.toFixed(1)}
        </span>
      </div>

      <div className="u" style={{ margin: "12px 0 8px" }}>
        Via color (default)
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <ColorSwatches options={VIA_COLOR_OPTIONS.slice(0, 8)} value={viaColor} onPick={setViaColor} />
        <ColorSwatches options={VIA_COLOR_OPTIONS.slice(8)} value={viaColor} onPick={setViaColor} />
      </div>

      {vias.length > 0 && (
        <>
          <div className="u" style={{ margin: "12px 0 8px" }}>
            Via layer colors
          </div>
          <div>
            {vias.map((v) => (
              <div key={v.id} style={{ marginBottom: 12, fontSize: 10 }}>
                <div style={{ color: "var(--ink3)", marginBottom: 6 }}>{v.id}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  <ColorSwatches
                    options={VIA_COLOR_OPTIONS.slice(0, 8)}
                    value={viaLayerColors[v.id] ?? v.color}
                    onPick={(c) => setViaLayerColor(v.id, c)}
                  />
                  <ColorSwatches
                    options={VIA_COLOR_OPTIONS.slice(8)}
                    value={viaLayerColors[v.id] ?? v.color}
                    onPick={(c) => setViaLayerColor(v.id, c)}
                  />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </SettingsPopover>
  );
}

/** Personal display name editor for a shared overlay source. */
function OverlayLayerLabel({ layerId, name }: { layerId: string; name: string }) {
  const renameLayer = useOverlayLayers((s) => s.renameLayer);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  useEffect(() => { if (!editing) setDraft(name); }, [name, editing]);
  const commit = () => {
    const next = draft.trim().slice(0, 120);
    if (next) renameLayer(layerId, next);
    setEditing(false);
  };
  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        maxLength={120}
        onChange={(event) => setDraft(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") { setDraft(name); setEditing(false); }
        }}
        onBlur={commit}
        style={{ width: "100%", minWidth: 0, background: "var(--l1)", color: "inherit", border: "1px solid var(--accent)" }}
      />
    );
  }
  return (
    <span
      title="Double-click to rename"
      onDoubleClick={(event) => { event.stopPropagation(); setEditing(true); }}
      style={{ cursor: "text" }}
    >
      {name}
    </span>
  );
}

/** Settings popover for an overlay image layer — opacity + delete. */
function OverlayLayerSettings({ layerId }: { layerId: string }) {
  const opacity = useOverlayLayers((s) => {
    const l = s.layers.find((x) => x.id === layerId);
    return l?.opacity ?? 1;
  });
  const setLayerOpacity = useOverlayLayers((s) => s.setLayerOpacity);
  const removeLayer = useOverlayLayers((s) => s.removeLayer);
  const pct = Math.round(opacity * 100);

  return (
    <SettingsPopover label="Overlay layer settings">
      <div className="u" style={{ marginBottom: 8 }}>
        Opacity
      </div>
      <div className="row" style={{ gap: 10 }}>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={pct}
          onChange={(e) =>
            setLayerOpacity(layerId, Number(e.target.value) / 100)
          }
        />
        <span
          className="m"
          style={{
            width: 36,
            color: "var(--ink2)",
            fontSize: 11,
            textAlign: "right"
          }}
        >
          {pct}%
        </span>
      </div>
      <button
        className="btn ghost"
        style={{
          marginTop: 8,
          width: "100%",
          justifyContent: "center",
          color: "var(--err)"
        }}
        onClick={() => removeLayer(layerId)}
      >
        {Ic.trash} Remove layer
      </button>
    </SettingsPopover>
  );
}

function CellSettingsButton() {
  const cellColor = usePreferences((s) => s.cellColor);
  const setCellColor = usePreferences((s) => s.setCellColor);
  const cellShowShapes = usePreferences((s) => s.cellShowShapes);
  const setCellShowShapes = usePreferences((s) => s.setCellShowShapes);

  return (
    <SettingsPopover label="Cell settings">
      <div className="u" style={{ marginBottom: 8 }}>
        Cell color
      </div>
      <ColorSwatches options={CELL_COLOR_OPTIONS} value={cellColor} onPick={setCellColor} />

      <label className="check" style={{ marginTop: 12 }}>
        <input
          type="checkbox"
          checked={cellShowShapes}
          onChange={(e) => setCellShowShapes(e.target.checked)}
        />
        Show cell details when zoomed in
      </label>
    </SettingsPopover>
  );
}
