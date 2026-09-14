import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { DieAnnotations, IOPin } from "shared";
import { useAnnotations } from "../api/annotations";
import { useDie } from "../api/dies";
import { apiPut } from "../api/client";
import { useIcPackageStore } from "../state/icPackage";
import { useOverlayLayers } from "../state/overlayLayers";
import { AppShell } from "../components/shell/AppShell";
import {
  findNearestPad,
  findClickedPin,
} from "../lib/ic-package/transform";
import { loadPackageGeom } from "../lib/ic-package/footprinter";
import { exportPinPlannerPng, exportPinTableCsv, buildPinTable } from "../lib/ic-package/export";
import { IcPackageToolbar } from "../components/ic-package/IcPackageToolbar";
import { OverlaySelector } from "../components/ic-package/OverlaySelector";
import { PackageSelector } from "../components/ic-package/PackageSelector";
import { PinListPanel } from "../components/ic-package/PinListPanel";
import { DieTransformPanel } from "../components/ic-package/DieTransformPanel";
import { IcPackageCanvas } from "../components/ic-package/IcPackageCanvas";
import { ShortcutsPanel } from "../components/dieViewer/ShortcutsPanel";
import { PIN_PLANNER_HOTKEYS } from "../lib/hotkeys";
import { isTypingTarget } from "../lib/keyboard";
import { useToast } from "../components/Toast";

export function IcPackagePage() {
  const [searchParams] = useSearchParams();
  const { dieId: routeDieId } = useParams<{ dieId: string }>();
  const dieId = routeDieId ?? searchParams.get("die") ?? null;

  if (!dieId) {
    return (
      <AppShell>
        <div className="m" style={{ flex: "1 1 auto", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink3)", fontSize: 12 }}>
          <span>no die selected — </span>
          <Link to="/" style={{ color: "var(--accent)", marginLeft: 4 }}>choose one from the library</Link>
        </div>
      </AppShell>
    );
  }
  return <IcPackageView key={dieId} dieId={dieId} />;
}

function IcPackageView({ dieId }: { dieId: string }) {
  const { data: die, isLoading, error } = useDie(dieId);
  const { data: annotations } = useAnnotations(dieId);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const overlayLayers = useOverlayLayers((s) => s.layers);
  // Persisted value is the STABLE serverFilename (tiled source id / legacy
  // filename); the runtime `bgOverlayId` is a per-session uuid and would
  // become stale across reloads.
  const [bgSource, setBgSource] = useState<string | null>(() => {
    try { return localStorage.getItem(`icPackage-bg-overlay-${dieId}`); } catch { return null; }
  });
  const [bgOverlayId, setBgOverlayId] = useState<string | null>(null);
  // Resolve the persisted source to a live layer id once it loads.
  useEffect(() => {
    if (!bgSource) { setBgOverlayId(null); return; }
    const layer = overlayLayers.find((l) => l.serverFilename === bgSource);
    setBgOverlayId(layer ? layer.id : null);
  }, [bgSource, overlayLayers]);
  const changeBgOverlay = useCallback((id: string | null) => {
    setBgOverlayId(id);
    const layer = id ? useOverlayLayers.getState().layers.find((l) => l.id === id) : undefined;
    const source = layer?.serverFilename ?? null;
    setBgSource(source);
    try {
      if (source) localStorage.setItem(`icPackage-bg-overlay-${dieId}`, source);
      else localStorage.removeItem(`icPackage-bg-overlay-${dieId}`);
    } catch { /* ignore */ }
  }, [dieId]);
  const [imageLoading, setImageLoading] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /** Pin being renamed via the inline canvas overlay. */
  const [editingPinNumber, setEditingPinNumber] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  /** Latest viewport so the inline input can track a pin's screen position. */
  const [viewport, setViewport] = useState<{ ox: number; oy: number; zoom: number }>({ ox: 0, oy: 0, zoom: 1 });

  // Load die image as a single static image (not tiled).
  const [dieImage, setDieImage] = useState<HTMLImageElement | null>(null);
  const [dieImageSize, setDieImageSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const dieIdRef = useRef<string | null>(null);

  // Auto-load overlays from server (same as DieViewerPage).
  const autoLoadRef = useRef(false);
  useEffect(() => {
    if (!dieId || autoLoadRef.current) return;
    autoLoadRef.current = true;
    void import("../api/overlayImages").then(async (mod) => {
      try {
        const list = await mod.fetchOverlayImageList(dieId);
        const addLayer = useOverlayLayers.getState().addLayer;
        const addTiledLayer = useOverlayLayers.getState().addTiledLayer;
        for (const source of list.images) {
          if (source.legacy) {
            try {
              const legacy = await mod.loadOverlayImageFromServer(dieId, source.originalFilename);
              addLayer(legacy.name, legacy.image, true, legacy.serverFilename);
            } catch { /* skip */ }
          } else {
            addTiledLayer(source, true);
          }
        }
      } catch { /* skip */ }
    });
  }, [dieId]);

  useEffect(() => {
    if (!die || !dieId) return;
    dieIdRef.current = dieId;
    setDieImage(null);
    setDieImageSize({ w: 0, h: 0 });
    setImageLoading(true);

    const loadFrom = (src: string) => {
      const img = new Image();
      img.onload = () => {
        if (dieIdRef.current !== dieId) return;
        // Guarantee the bitmap is fully decoded before handing it to the
        // canvas; otherwise the first drawImage can paint a blank frame and
        // nothing ever triggers a repaint (black until pan/zoom/hover).
        img.decode().then(() => {
          if (dieIdRef.current !== dieId) return;
          let w = img.naturalWidth;
          let h = img.naturalHeight;
          const maxEdge = Math.max(w, h);
          if (maxEdge > 4096) {
            const s = 4096 / maxEdge;
            const c = document.createElement("canvas");
            c.width = Math.round(w * s);
            c.height = Math.round(h * s);
            c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
            // Use a FRESH Image for the data URL: assigning img.src would reset
            // its load state, and drawing it before the data URL decodes renders
            // nothing (black canvas) with no follow-up redraw.
            const out = new Image();
            out.onload = () => {
              if (dieIdRef.current !== dieId) return;
              out.decode().then(() => {
                if (dieIdRef.current !== dieId) return;
                setDieImage(out);
                setDieImageSize({ w: c.width, h: c.height });
                setImageLoading(false);
              }).catch(() => {});
            };
            out.src = c.toDataURL("image/jpeg", 0.92);
            return;
          }
          setDieImage(img);
          setDieImageSize({ w, h });
          setImageLoading(false);
        }).catch(() => {});
      };
      img.onerror = () => {
        if (dieIdRef.current !== dieId) return;
        setImageLoading(false);
      };
      img.src = src;
    };

    // Resolve the background image URL: base die photo, or a selected overlay.
    let src = `/api/dies/${dieId}/image`;
    if (bgOverlayId) {
      const layer = useOverlayLayers.getState().layers.find((l) => l.id === bgOverlayId);
      if (layer?.source && !layer.source.legacy) {
        // Tiled overlay: serve its stored original via the manifest route.
        src = `/api/dies/${dieId}/overlay-images/${layer.source.id}/original`;
      } else if (layer?.image) {
        // Legacy overlay already decoded.
        src = layer.image.src;
      }
    }
    loadFrom(src);
  }, [dieId, die, bgOverlayId]);

  // Seed store from annotations.
  const loadFromAnnotations = useIcPackageStore((s) => s.loadFromAnnotations);
  useEffect(() => { loadFromAnnotations(annotations); }, [annotations, loadFromAnnotations]);

  // Subscribe to store state.
  const footprint = useIcPackageStore((s) => s.footprint);
  const pins = useIcPackageStore((s) => s.pins);
  const bonds = useIcPackageStore((s) => s.bonds);
  const transform = useIcPackageStore((s) => s.transform);
  const tool = useIcPackageStore((s) => s.tool);
  const setTool = useIcPackageStore((s) => s.setTool);
  const selectedPinNumber = useIcPackageStore((s) => s.selectedPinNumber);
  const hoveredPadId = useIcPackageStore((s) => s.hoveredPadId);
  const setHoveredPad = useIcPackageStore((s) => s.setHoveredPad);
  const selectPin = useIcPackageStore((s) => s.selectPin);
  const addBond = useIcPackageStore((s) => s.addBond);
  const namePin = useIcPackageStore((s) => s.namePin);
  const removePinName = useIcPackageStore((s) => s.removePinName);
  const bondWireWidthUm = useIcPackageStore((s) => s.bondWireWidthUm);

  const geom = useMemo(() => {
    try { return loadPackageGeom(footprint); } catch { return null; }
  }, [footprint]);

  // ── Coordinate system ───────────────────────────────────────────
  // The rendered image is downscaled from the original (die.width/height are
  // ORIGINAL pixel dims).  All die-space coordinates (IOPin pads) must be
  // multiplied by this factor to land on the rendered image.
  const downscale = die && dieImageSize.w > 0 && die.width > 0
    ? dieImageSize.w / die.width
    : 1;

  const umPerPx = annotations?.umPerPx;
  const geomBodyW = geom ? geom.body.maxX - geom.body.minX : 5;
  // pxPerMm in rendered-image (world) coordinates.
  //  - If the user calibrated the photo (umPerPx set): physical scale.
  //  - Otherwise: default so the package body spans ~135 % of the die width
  //    (a real package is always larger than the die it hosts).
  const pxPerMm = umPerPx && umPerPx > 0
    ? (1000 / umPerPx) * downscale
    : geomBodyW > 0
      ? (dieImageSize.w * 1.35) / geomBodyW
      : dieImageSize.w / 10;

  // Package origin is the centre of the RENDERED die image (imgW×imgH).
  const packageOrigin = useMemo(() =>
    ({ x: dieImageSize.w / 2, y: dieImageSize.h / 2 }),
    [dieImageSize.w, dieImageSize.h]
  );

  // Pads live in ORIGINAL source-pixel space — scale them to the rendered
  // image so markers, bonds and hit-testing all agree with what's on screen.
  const scaledPads = useMemo<IOPin[]>(() => {
    const raw = annotations?.pins ?? [];
    if (downscale === 1) return raw;
    return raw.map((p) => ({ ...p, x: p.x * downscale, y: p.y * downscale }));
  }, [annotations?.pins, downscale]);

  const bondedPadIds = useMemo(() => new Set(bonds.map((b) => b.diePadId)), [bonds]);

  // ── Keyboard shortcuts ─────────────────────────────────────────
  //   S pan · T text (name) · W bond · Ctrl+/ or ? → help panel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === "/") {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }
      if (e.key === "?" && !meta && !e.altKey) {
        setShortcutsOpen((v) => !v);
        return;
      }
      if (meta || e.altKey) return;
      const nextTool = PIN_PLANNER_HOTKEYS[e.key.toLowerCase()];
      if (nextTool) setTool(nextTool);
    };
    const onToggle = () => setShortcutsOpen((v) => !v);
    window.addEventListener("keydown", onKey);
    window.addEventListener("toggle-shortcuts", onToggle);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("toggle-shortcuts", onToggle);
    };
  }, [setTool]);

  // ── Save ─────────────────────────────────────────────────────────
  const save = useCallback(async () => {
    if (!annotations || !die) return;
    setSaveStatus("saving");
    try {
      const next: DieAnnotations = { ...annotations, icPackage: useIcPackageStore.getState().toConfig() };
      await apiPut(`/api/dies/${dieId}/annotations`, next);
      queryClient.setQueryData(["annotations", dieId], next);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 1200);
    } catch (e) {
      setSaveStatus("error");
      toast.error(`Save failed: ${(e as Error).message}`);
    }
  }, [annotations, die, dieId, queryClient, toast]);

  useEffect(() => {
    if (!annotations) return;
    const t = window.setTimeout(() => void save(), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bonds, transform, footprint, bondWireWidthUm, pins.map((p) => p.name).join("|")]);

  // ── Apply to Die Viewer pins ────────────────────────────────────
  const applyToDieViewer = useCallback(async () => {
    if (!annotations || !die) return;
    const { pins: pkgPins, bonds: pkgBonds } = useIcPackageStore.getState();
    const nameByNum = new Map<number, string>();
    for (const p of pkgPins) { const n = p.name.trim(); if (n) nameByNum.set(p.number, n); }
    const padIdToName = new Map<string, string>();
    for (const b of pkgBonds) { const n = nameByNum.get(b.pinNumber); if (n) padIdToName.set(b.diePadId, n); }
    if (padIdToName.size === 0) { toast.warning("No named bonds."); return; }
    let updated = 0;
    const nextPins = (annotations.pins ?? []).map((p) => {
      const n = padIdToName.get(p.id);
      if (n && p.name !== n) { updated++; return { ...p, name: n }; }
      return p;
    });
    if (updated === 0) { toast.warning("Already synced."); return; }
    const next: DieAnnotations = { ...annotations, pins: nextPins };
    setSaveStatus("saving");
    try {
      await apiPut(`/api/dies/${dieId}/annotations`, next);
      queryClient.setQueryData(["annotations", dieId], next);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 1200);
      toast.success(`Applied names to ${updated} die pad(s).`);
    } catch (e) {
      setSaveStatus("error");
      toast.error(`Apply failed: ${(e as Error).message}`);
    }
  }, [annotations, die, dieId, queryClient, toast]);

  const applyDisabled = useMemo(() => {
    const namedNums = new Set(pins.filter((p) => p.name.trim()).map((p) => p.number));
    return !bonds.some((b) => namedNums.has(b.pinNumber));
  }, [pins, bonds]);

  // ── Export ──────────────────────────────────────────────────────
  const exportPng = useCallback(() => {
    if (!dieImage) return;
    exportPinPlannerPng({
      dieImage,
      imgW: dieImageSize.w,
      imgH: dieImageSize.h,
      transform,
      pxPerMm,
      packageOrigin,
      geom,
      pins,
      pads: scaledPads,
      bonds,
      bondedPadIds,
      bondWireWidthUm,
    });
  }, [dieImage, dieImageSize.w, dieImageSize.h, transform, pxPerMm, packageOrigin, geom, pins, scaledPads, bonds, bondedPadIds, bondWireWidthUm]);

  const exportCsv = useCallback(() => {
    exportPinTableCsv(buildPinTable(pins, bonds, annotations?.pins ?? []));
  }, [pins, bonds, annotations?.pins]);

  // ── Render ───────────────────────────────────────────────────────
  const centerMsg = !die
    ? (isLoading ? "loading die…" : error ? `error: ${(error as Error).message}` : "loading…")
    : imageLoading || !dieImage
      ? "loading image…"
      : null;

  return (
    <AppShell meta="Pin planner" savedAgo={saveStatus === "saved" ? "saved" : saveStatus === "saving" ? "saving…" : saveStatus === "error" ? "save failed" : undefined}>
      <IcPackageToolbar onApplyToDieViewer={applyToDieViewer} applyDisabled={applyDisabled}
        onExportPng={exportPng} onExportCsv={exportCsv}
        right={<OverlaySelector value={bgOverlayId} onChange={changeBgOverlay} />} />
      <div style={{ flex: "1 1 auto", display: "flex", minHeight: 0 }}>
        {centerMsg ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink3)", fontSize: 12 }}>
            {centerMsg}
          </div>
        ) : (
          <>
            <div style={{ position: "relative", flex: "1 1 auto", minWidth: 0, display: "flex" }}>
              <IcPackageCanvas
                dieImage={dieImage}
                imgW={dieImageSize.w}
                imgH={dieImageSize.h}
                transform={transform}
                pxPerMm={pxPerMm}
                packageOrigin={packageOrigin}
                geom={geom}
                pins={pins}
                pads={scaledPads}
                bonds={bonds}
                bondedPadIds={bondedPadIds}
                hoveredPadId={hoveredPadId}
                selectedPinNumber={selectedPinNumber}
                tool={tool}
                bondWireWidthUm={bondWireWidthUm}
                onViewportChange={(vp) => setViewport(vp)}
                onPadHover={setHoveredPad}
                onPinClick={(num) => {
                  if (tool === "name") {
                    const pin = pins.find((p) => p.number === num);
                    setEditDraft(pin?.name ?? "");
                    setEditingPinNumber(num);
                  } else if (tool === "bond") {
                    selectPin(selectedPinNumber === num ? null : num);
                  }
                }}
                onPadClick={(padId) => {
                  if (tool === "bond" && selectedPinNumber != null) {
                    addBond(selectedPinNumber, padId);
                  }
                }}
              />
              {editingPinNumber != null && tool === "name" && (() => {
                const pin = pins.find((p) => p.number === editingPinNumber);
                if (!pin) return null;
                const wx = packageOrigin.x + pin.x * pxPerMm;
                const wy = packageOrigin.y + pin.y * pxPerMm;
                const left = (wx - viewport.ox) * viewport.zoom;
                const top = (wy - viewport.oy) * viewport.zoom;
                if (left < -160 || top < -40 || left > 2000 || top > 2000) return null;
                return (
                  <input
                    autoFocus
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onFocus={(e) => e.target.select()}
                    onBlur={() => {
                      const name = editDraft.trim();
                      if (name) namePin(pin.number, name);
                      else removePinName(pin.number);
                      setEditingPinNumber(null);
                      setEditDraft("");
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") {
                        setEditingPinNumber(null);
                        setEditDraft("");
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                    style={{
                      position: "absolute",
                      left: left + 8,
                      top: top - 20,
                      zIndex: 20,
                      minWidth: 96,
                      fontFamily: "ui-monospace, monospace",
                      fontSize: 13,
                      padding: "3px 7px",
                      background: "var(--card)",
                      color: "var(--ink)",
                      border: "1px solid var(--accent)",
                      borderRadius: 3,
                      outline: "none",
                      boxShadow: "0 2px 10px rgba(0,0,0,0.5)",
                    }}
                    placeholder={`pin ${pin.number} name`}
                    title="Enter saves, Esc cancels"
                  />
                );
              })()}
            </div>
            <div style={{ width: 260, flex: "0 0 auto", borderLeft: "1px solid var(--l2)", background: "var(--card)", display: "flex", flexDirection: "column", padding: 8, gap: 8, overflowY: "auto" }}>
              <PackageSelector />
              <DieTransformPanel />
              <PinListPanel pads={scaledPads} />
            </div>
          </>
        )}
      </div>
      <ShortcutsPanel open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </AppShell>
  );
}
