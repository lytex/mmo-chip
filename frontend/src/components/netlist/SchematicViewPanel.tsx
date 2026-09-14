/**
 * SchematicViewPanel.tsx — Renders schematics and functional block diagrams.
 *
 * Two render modes:
 *   - Analog: transistor-level schematic via netlist2svg (ELK layout)
 *   - Functional: block diagram showing floorplan regions as sub-module rectangles
 *
 * ⚠ We previously experimented with @spice-ts/ui as an alternative SVG schematic
 *   renderer, but its rendering quality was poor and it lacked customisation.
 *   It has been replaced entirely by netlist2svg.  The old import and types
 *   (SpiceSchematicPrototype, SpiceTSResult, generateSpiceTSViews) remain in
 *   the file for reference but are no longer wired into the UI.
 *
 * netlist2svg loads ELK.js (~2MB) on first use.
 */

import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import type { DieAnnotations, FloorplanRegion, SpiceConfig } from "shared";
import { generateSpiceTSViews } from "../../lib/schematic/spiceTSFormat";
import { Netlist2SvgView, type Netlist2SvgHandle } from "./Netlist2SvgView";
import { LAYOUT_STRATEGIES, LAYOUT_DIRECTIONS, COMPACTION_LEVELS, type LayoutStrategy, type LayoutDirection, type CompactionLevel } from "../../lib/schematic/netlist2svgSkin";
import { formatDevicesAsNetlist2Svg } from "../../lib/schematic/netlist2svgFormat";
import { parseNetlistToDevices } from "../../lib/schematic/netlistTextToDevices";
import { generateBlockDiagram } from "../../lib/schematic/blockDiagramFormat";
import { NetlistSettingsPanel } from "./NetlistSettingsPanel";
import { collectDieWideAnalogDevices, getRenameVersion } from "../../api/dieWideAnalog";
import { matchGeometry } from "../../lib/export/matching";
import { regionExternalNets, type HierarchyBlock } from "../../lib/schematic/interactiveAnalogLayout";
import { InteractiveAnalogSchematic } from "./InteractiveAnalogSchematic";
import { scopeKey as interactiveScopeKey } from "../../state/interactiveSchematic";
import { useSession } from "../../state/session";
import { usePreferences } from "../../state/preferences";

// ── Props ───────────────────────────────────────────────────────

interface Props {
  annotations: DieAnnotations;
  moduleName: string;
  hierarchical: boolean;
  spiceConfig?: SpiceConfig;
  floorplanRegions?: FloorplanRegion[];
  /** Currently selected region id (controlled from parent for persistence) */
  selectedRegion?: string | null;
  /** Called when user clicks a region button */
  onSelectRegion?: (regionId: string | null) => void;
  /** Optional read-only assistant finding: render this device subset as a schematic fragment. */
  selectedDeviceNames?: string[];
  /**
   * Optional hand-edited netlist text (from the Code tab). When present, it
   * fully overrides the die-derived devices below — the schematic renders a
   * tentative sketch parsed straight from this text instead of extraction
   * results. Hierarchy/regions don't apply to a flat hand-typed netlist.
   */
  manualSource?: string | null;
}

// ── Component ───────────────────────────────────────────────────

export function SchematicViewPanel({
  annotations,
  moduleName,
  hierarchical,
  spiceConfig,
  floorplanRegions,
  selectedRegion: selectedRegionProp,
  onSelectRegion,
  selectedDeviceNames = [],
  manualSource = null,
}: Props) {
  const [renderMode, setRenderMode] = useState<"analog" | "functional">("analog");
  /** Schematic engine: static netlist2svg SVG or interactive draggable canvas.
   *  Interactive is the default (legacy static is opt-in). */
  const [engine, setEngine] = useState<"static" | "interactive">("interactive");
  /** Netlist render settings modal. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const dieId = useSession((s) => s.dieId);

  // Persisted (user settings) layout + fine ELK tuning.
  const layoutStrategy = usePreferences((s) => s.netlistLayoutStrategy);
  const layoutDirection = usePreferences((s) => s.netlistLayoutDirection);
  const compactionLevel = usePreferences((s) => s.netlistCompaction);
  const nodeNode = usePreferences((s) => s.netlistNodeNode);
  const betweenLayers = usePreferences((s) => s.netlistBetweenLayers);
  const edgeEdge = usePreferences((s) => s.netlistEdgeEdge);
  const edgeNode = usePreferences((s) => s.netlistEdgeNode);
  const favorStraightEdges = usePreferences((s) => s.netlistFavorStraightEdges);
  const showIoPins = usePreferences((s) => s.netlistShowIoPins);
  const showHierarchy = usePreferences((s) => s.netlistShowHierarchy);
  const showLegacyStatic = usePreferences((s) => s.netlistShowLegacyStatic);
  const dragMode = usePreferences((s) => s.netlistDragMode);
  const {
    setNetlistLayoutStrategy: setLayoutStrategy,
    setNetlistLayoutDirection: setLayoutDirection,
    setNetlistCompaction: setCompactionLevel,
    setNetlistNodeNode: setNodeNode,
    setNetlistBetweenLayers: setBetweenLayers,
    setNetlistEdgeEdge: setEdgeEdge,
    setNetlistEdgeNode: setEdgeNode,
    setNetlistFavorStraightEdges: setFavorStraightEdges,
    setNetlistShowIoPins: setShowIoPins,
    setNetlistShowHierarchy: setShowHierarchy,
    setNetlistShowLegacyStatic: setShowLegacyStatic,
    setNetlistDragMode: setDragMode,
  } = usePreferences.getState();

  const n2sRef = useRef<Netlist2SvgHandle>(null);

  // Auto-disable hierarchy when a subcircuit is selected — hierarchy only
  // makes sense on the "All" view.
  useEffect(() => {
    if (selectedDeviceNames.length > 0 && showHierarchy) setShowHierarchy(false);
  }, [selectedDeviceNames, showHierarchy]);

  // ══ Generate spice-ts views ═══════════════════════════════════
  const views = useMemo(
    () => generateSpiceTSViews(annotations, moduleName, spiceConfig, hierarchical ? floorplanRegions : undefined),
    [annotations, moduleName, spiceConfig, hierarchical, floorplanRegions],
  );

  // ══ Generate netlist2svg views ════════════════════════════════
  const n2sData = useMemo(() => {
    const config: SpiceConfig = { vdd: "VDD", gnd: "GND", ...spiceConfig };
    const { devices, namedNets, ioNetIds } = collectDieWideAnalogDevices(
      annotations,
      spiceConfig?.umPerPx ?? annotations.umPerPx ?? 1.0,
      config,
    );
    // Devices already have stable instance names from assignStableInstanceNames
    // inside collectDieWideAnalogDevices. No need to call assignInstanceNames.
    const named = devices;
    matchGeometry(named as any[], config, namedNets);

    // Build hierarchical (per-region) device lists
    let floorplanDevices: Map<string, AnalogDevice[]> | undefined;
    if (hierarchical && floorplanRegions && floorplanRegions.length > 0) {
      floorplanDevices = new Map();
      const assignedKeys = new Set<string>();
      const typedDevices = named as (import("shared").AnalogDevice & { instanceName: string })[];
      
      for (const region of floorplanRegions) {
        const inside: typeof typedDevices = [];
        for (const d of typedDevices) {
          const key = d.instanceName ?? d.id;
          if (assignedKeys.has(key)) continue;
          if (deviceInRegion(d, region)) {
            inside.push(d);
            assignedKeys.add(key);
          }
        }
        if (inside.length > 0) {
          floorplanDevices.set(region.id, inside as any);
        }
      }

      // Unassigned devices
      const unassigned = typedDevices.filter((d) => {
        const k = d.instanceName ?? d.id;
        return !assignedKeys.has(k);
      });
      if (unassigned.length > 0) {
        floorplanDevices.set("__unassigned__", unassigned as any);
      }
    }

    const flat = formatDevicesAsNetlist2Svg(
      named,
      namedNets,
      moduleName,
      { vdd: config.vdd ?? "VDD", gnd: config.gnd ?? "GND", hierarchical, ioNetIds, showNetLabels: false },
    );

    return { flatJson: flat, floorplanDevices, namedNets, ioNetIds, devices: named as import("shared").AnalogDevice[] };
  }, [annotations, moduleName, spiceConfig, hierarchical, floorplanRegions, getRenameVersion()]);

  // ══ Manual/tentative override — hand-edited netlist from the Code tab ═
  // When present, this fully replaces the die-derived n2sData below with
  // devices parsed straight from the user's text, so a schematic can be
  // sketched before real layout extraction exists. Flat only — hierarchy
  // and floorplan regions don't apply to hand-typed text.
  const manualData = useMemo(() => {
    if (!manualSource || !manualSource.trim()) return null;
    return parseNetlistToDevices(manualSource);
  }, [manualSource]);
  const isManual = manualData !== null;

  const effectiveN2s = useMemo(() => {
    if (!manualData) return n2sData;
    const flat = formatDevicesAsNetlist2Svg(
      manualData.devices,
      manualData.namedNets,
      `${moduleName}.tentative`,
      { vdd: spiceConfig?.vdd ?? "VDD", gnd: spiceConfig?.gnd ?? "GND", hierarchical: false, ioNetIds: new Set(), showNetLabels: false },
    );
    return {
      flatJson: flat,
      floorplanDevices: undefined as Map<string, AnalogDevice[]> | undefined,
      namedNets: manualData.namedNets,
      ioNetIds: new Set<number>(),
      devices: manualData.devices,
    };
  }, [manualData, n2sData, moduleName, spiceConfig]);

  // ══ Functional block diagram ═════════════════════════════════
  const blockDiagramJson = useMemo(() => {
    if (isManual) return null;
    if (!hierarchical || !floorplanRegions || floorplanRegions.length === 0) return null;
    if (!n2sData.floorplanDevices) return null;
    // Separate region blocks from unassigned (top-level) devices
    const regionDevices = new Map<string, AnalogDevice[]>();
    let unassignedDevices: AnalogDevice[] = [];
    for (const [regionId, devices] of n2sData.floorplanDevices) {
      if (regionId === "__unassigned__") {
        unassignedDevices = devices;
      } else {
        regionDevices.set(regionId, devices);
      }
    }
    // At least one real region is needed
    if (regionDevices.size === 0 && unassignedDevices.length === 0) return null;
    if (regionDevices.size === 0) return null; // only unassigned — use analog view instead
    const cfg: SpiceConfig = { vdd: "VDD", gnd: "GND", ...spiceConfig };
    return generateBlockDiagram(
      regionDevices,
      floorplanRegions,
      n2sData.namedNets,
      n2sData.ioNetIds,
      moduleName,
      { vdd: cfg.vdd ?? "VDD", gnd: cfg.gnd ?? "GND" },
      unassignedDevices.length > 0 ? unassignedDevices : undefined,
    );
  }, [isManual, hierarchical, floorplanRegions, n2sData, moduleName, spiceConfig]);

  /** Is functional mode available? Need hierarchical + regions with devices */
  const functionalAvail = blockDiagramJson !== null;

  // ── Region state ──────────────────────────────────────────────
  const regionIds = useMemo(
    () => [...views.perRegion.keys()],
    [views.perRegion],
  );
  const [internalRegion, setInternalRegion] = useState<string | null>(null);
  // When the parent's selectedRegion prop changes, clear internal state
  // so the prop always wins (keeps SubcircuitPicker and schematic in sync).
  useEffect(() => { setInternalRegion(null); }, [selectedRegionProp]);
  const activeRegion = selectedRegionProp ?? internalRegion;

  // ── Download handler (netlist2svg only) ──────────────────────
  const handleDownload = useCallback((format: "svg" | "png" | "json") => {
    const region = activeRegion ? activeRegion.slice(0, 8) : "full";
    const baseName = `${moduleName}_${region}`;

    if (format === "json") {
      const json = n2sRef.current?.getJson();
      if (!json) return;
      const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
      downloadBlob(blob, `${baseName}.json`);
      return;
    }

    const svgString = n2sRef.current?.getSvgString();
    if (!svgString) return;

    if (format === "svg") {
      const blob = new Blob([svgString], { type: "image/svg+xml" });
      downloadBlob(blob, `${baseName}.svg`);
      return;
    }

    // PNG: render SVG to canvas
    const size = n2sRef.current?.getSvgSize();
    if (!size) return;
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(size.width * scale);
    canvas.height = Math.round(size.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (blob) downloadBlob(blob, `${baseName}.png`);
      }, "image/png");
    };
    img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svgString)));
  }, [activeRegion, moduleName]);

  // Sync internal region when regions change. "" (All) is a valid selection —
// the default with hierarchy enabled — so we only re-pin a stale CONCRETE
// region, never force regionIds[0] over the empty "All" state.
useEffect(() => {
  if (regionIds.length > 0 && activeRegion != null && activeRegion !== "" && !regionIds.includes(activeRegion)) {
    const next = regionIds[0];
    setInternalRegion(next);
    onSelectRegion?.(next);
  }
}, [regionIds.join(",")]);

  // Legacy static renderer is opt-in: when hidden, force the interactive
  // engine and the analog render mode (a stale persisted "static" choice or
  // hidden "functional" from an earlier session must not override defaults).
  useEffect(() => {
    if (!showLegacyStatic && engine !== "interactive") setEngine("interactive");
    if (!showLegacyStatic && renderMode !== "analog") setRenderMode("analog");
  }, [showLegacyStatic, engine, renderMode]);

  const handleSelectRegion = (id: string) => {
    setInternalRegion(id);
    onSelectRegion?.(id);
    // A concrete region means "open that block": leave the hierarchy
    // overview so the tab (bandgap, …) shows the per-region schematic even
    // when the hierarchy toggle is on. "All" keeps the current hierarchy
    // state (overview when enabled).
    if (id) setShowHierarchy(false);
  };

  // ── Current data ──────────────────────────────────────────────

  const currentN2sJson = useMemo(() => {
    if (isManual) return effectiveN2s.flatJson;
    if (selectedDeviceNames.length > 0) {
      const selected = n2sData.devices.filter((device) => selectedDeviceNames.includes(device.instanceName ?? device.id));
      if (selected.length > 0) {
        return formatDevicesAsNetlist2Svg(
          selected,
          n2sData.namedNets,
          `${moduleName}.assistant_fragment`,
          { vdd: spiceConfig?.vdd ?? "VDD", gnd: spiceConfig?.gnd ?? "GND", hierarchical: false, ioNetIds: n2sData.ioNetIds, showNetLabels: true },
        );
      }
    }
    if (hierarchical && activeRegion && n2sData.floorplanDevices) {
      const regionDevices = n2sData.floorplanDevices.get(activeRegion);
      if (regionDevices) {
        return formatDevicesAsNetlist2Svg(
          regionDevices,
          n2sData.namedNets,
          `${moduleName}.${activeRegion.slice(0, 8)}`,
          { vdd: spiceConfig?.vdd ?? "VDD", gnd: spiceConfig?.gnd ?? "GND", hierarchical, ioNetIds: n2sData.ioNetIds, showNetLabels: false },
        );
      }
      return null;
    }
    return n2sData.flatJson;
  }, [isManual, effectiveN2s, hierarchical, activeRegion, n2sData, moduleName, spiceConfig, selectedDeviceNames]);

  // ── Hierarchy blocks ─────────────────────────────────────────
  // Floorplan regions collapsed into subcircuit rectangles (interactive
  // "show hierarchy"). Defined BEFORE interactiveScope (it keys the slot).
  const hierarchyBlocks: HierarchyBlock[] | undefined = useMemo(() => {
    if (isManual) return undefined;
    if (!showHierarchy) return undefined;
    if (selectedDeviceNames.length > 0) return undefined; // hierarchy only on "All"
    if (!hierarchical || !floorplanRegions || floorplanRegions.length === 0) return undefined;
    if (!n2sData.floorplanDevices) return undefined;
    const regionDevices = new Map<string, AnalogDevice[]>();
    let unassignedDevices: AnalogDevice[] = [];
    for (const [regionId, devs] of n2sData.floorplanDevices) {
      if (regionId === "__unassigned__") unassignedDevices = devs;
      else regionDevices.set(regionId, devs);
    }
    if (regionDevices.size === 0) return undefined;
    const cfg: SpiceConfig = { vdd: "VDD", gnd: "GND", ...spiceConfig };
    // region.name is the readable block label (not the raw regionId).
    const regionNames = new Map<string, string>();
    for (const r of floorplanRegions) regionNames.set(r.id, r.name ?? r.id);
    return regionExternalNets(
      regionDevices,
      unassignedDevices,
      n2sData.ioNetIds,
      n2sData.namedNets,
      { vdd: cfg.vdd ?? "VDD", gnd: cfg.gnd ?? "GND" },
      regionNames,
    );
  }, [isManual, showHierarchy, hierarchical, floorplanRegions, n2sData, spiceConfig]);

  // ── Region boundary pins (shown when viewing a subcircuit) ─────
  // When a region is selected (subcircuit view) and hierarchy overview is off,
  // compute the block's external nets so InteractiveAnalogSchematic can render
  // them as labeled pins at the canvas edges (inputs left, outputs right).
  // Works for both floorplan regions AND device subsets (AI/netlist subcircuits).
  const regionPins: HierarchyBlock["nets"] | undefined = useMemo(() => {
    if (showHierarchy) return undefined; // hierarchy view shows full blocks
    if (!hierarchical) return undefined;
    // Determine which devices are currently displayed
    let displayedDevices: AnalogDevice[] | undefined;
    if (selectedDeviceNames.length > 0) {
      // Device subset selected (AI/netlist subcircuit from picker)
      displayedDevices = n2sData.devices.filter((d) => selectedDeviceNames.includes(d.instanceName ?? d.id));
    } else if (activeRegion && n2sData.floorplanDevices) {
      // Floorplan region selected
      displayedDevices = n2sData.floorplanDevices.get(activeRegion);
    }
    if (!displayedDevices || displayedDevices.length === 0) return undefined;
    // Compute boundary nets: nets used by displayed devices that also appear
    // in other devices or are die I/O pins.
    const cfg: SpiceConfig = { vdd: "VDD", gnd: "GND", ...spiceConfig };
    const vdd = cfg.vdd ?? "VDD";
    const gnd = cfg.gnd ?? "GND";
    const displayedDeviceKeys = new Set(displayedDevices.map((d) => d.instanceName ?? d.id));
    const displayedNetIds = new Set<number>();
    for (const d of displayedDevices) for (const t of d.terminals) if (t.netId >= 0) displayedNetIds.add(t.netId);
    // Nets used by devices OUTSIDE the selection
    const externalNetIds = new Set<number>();
    for (const d of n2sData.devices) {
      if (displayedDeviceKeys.has(d.instanceName ?? d.id)) continue;
      for (const t of d.terminals) if (t.netId >= 0) externalNetIds.add(t.netId);
    }
    const nets: HierarchyBlock["nets"] = [];
    for (const netId of displayedNetIds) {
      const name = n2sData.namedNets.get(netId);
      if (!name) continue;
      if (name === vdd || name === gnd) continue;
      if (!externalNetIds.has(netId) && !n2sData.ioNetIds.has(netId)) continue;
      // Infer direction: gate/base = input, else output
      let hasGate = false;
      let hasPassive = false;
      for (const d of displayedDevices) {
        for (const t of d.terminals) {
          if (t.netId !== netId) continue;
          if (d.kind === "mos" && t.name === "G") hasGate = true;
          else if ((d.kind === "bjt_npn" || d.kind === "bjt_pnp") && t.name === "B") hasGate = true;
          else if ((d.kind === "jfet_n" || d.kind === "jfet_p") && t.name === "G") hasGate = true;
          else hasPassive = true;
        }
      }
      const direction: "input" | "output" = hasGate && hasPassive ? "output" : hasGate ? "input" : "output";
      nets.push({ netId, name, direction });
    }
    return nets.length > 0 ? nets : undefined;
  }, [showHierarchy, hierarchical, activeRegion, selectedDeviceNames, n2sData, spiceConfig]);

  // ── Interactive engine data (draggable canvas) ────────────────
  // Scope slot keeps layouts of different datasets (full / region /
  // assistant fragment) apart in the persisted store.
  const interactiveScope = useMemo(() => {
    if (isManual) return "tentative";
    if (selectedDeviceNames.length > 0) return `fragment:${hashFragmentScope(selectedDeviceNames)}`;
    if (showHierarchy && hierarchyBlocks) return "hierarchy";
    if (hierarchical && activeRegion) return `region:${activeRegion}`;
    return "full";
  }, [isManual, selectedDeviceNames, hierarchical, activeRegion, showHierarchy, hierarchyBlocks]);

  const interactiveDevices = useMemo(() => {
    if (isManual) return effectiveN2s.devices;
    if (selectedDeviceNames.length > 0) {
      const selected = n2sData.devices.filter((device) => selectedDeviceNames.includes(device.instanceName ?? device.id));
      if (selected.length > 0) return selected;
    }
    if (hierarchical && activeRegion && n2sData.floorplanDevices) {
      const regionDevices = n2sData.floorplanDevices.get(activeRegion);
      if (regionDevices) return regionDevices;
      return [];
    }
    return n2sData.devices;
  }, [isManual, effectiveN2s, hierarchical, activeRegion, n2sData, selectedDeviceNames]);

  // I/O pin net ids:
  // - "All" view: show all die I/O pins when the toggle is on
  // - Subcircuit view: no die I/O pins (only block I/O pins via regionPins)
  const interactiveIoNetIds = useMemo(() => {
    if (selectedDeviceNames.length > 0) return undefined;
    // When a region is selected (subcircuit view), hide die IO pins —
    // block boundary pins (regionPins) already represent the same nets.
    if (activeRegion && !showHierarchy) return undefined;
    return showIoPins ? n2sData.ioNetIds : undefined;
  }, [showIoPins, selectedDeviceNames, activeRegion, showHierarchy, n2sData.ioNetIds]);

  // When hierarchy is shown (and no subcircuit is selected), the interactive
  // canvas lays out ONLY the top-level (unassigned) devices — region contents
  // collapse into block nodes (passed via `blocks`).  When a subcircuit is
  // selected, show all its devices flat (no block filtering).
  const interactiveDevicesWithHierarchy = useMemo(() => {
    if (selectedDeviceNames.length > 0) return interactiveDevices;
    if (!hierarchyBlocks) return interactiveDevices;
    return n2sData.devices.filter((d) =>
      !hierarchyBlocks.some((b) =>
        (n2sData.floorplanDevices?.get(b.regionId) ?? []).some(
          (rd) => (rd.instanceName ?? rd.id) === (d.instanceName ?? d.id),
        ),
      ),
    );
  }, [hierarchyBlocks, interactiveDevices, n2sData, selectedDeviceNames]);

  // ── Drilling into a hierarchy block ──────────────────────────
  // Double-click on a block (interactive hierarchy) opens that region's
  // schematic: select the region and leave the hierarchy overview, so the
  // interactive canvas shows the region's devices (per-region slot).
  const handleOpenBlock = useCallback((regionId: string) => {
    setInternalRegion(regionId);
    onSelectRegion?.(regionId);
    setShowHierarchy(false);
  }, [onSelectRegion]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* ── Toolbar: engine toggle + region buttons ────────────── */}
      <div
        style={{
          display: "flex",
          gap: 4,
          padding: "6px 8px",
          background: "var(--l1)",
          borderBottom: "1px solid var(--l2)",
          overflow: "auto",
          flexShrink: 0,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        {/* ── Render mode toggle: Analog vs Functional (legacy static only) ── */}
        {showLegacyStatic && (
        <div
          className="row"
          style={{
            gap: 2,
            background: "var(--l2)",
            borderRadius: 4,
            padding: 2,
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            className={"btn sm" + (renderMode === "analog" ? " on" : "")}
            onClick={() => setRenderMode("analog")}
            style={{ fontSize: 10, fontWeight: 600 }}
            title="Transistor-level analog schematic"
          >
            Analog
          </button>
          <button
            type="button"
            className={"btn sm" + (renderMode === "functional" ? " on" : "")}
            onClick={() => {
              if (functionalAvail) setRenderMode("functional");
            }}
            style={{
              fontSize: 10,
              fontWeight: 600,
              opacity: functionalAvail ? 1 : 0.4,
              cursor: functionalAvail ? "pointer" : "default",
            }}
            title={functionalAvail ? "Functional block diagram (region-based)" : "No floorplan regions available"}
          >
            Functional
          </button>
        </div>
        )}

        {/* ── Engine toggle: Static vs Interactive (legacy static only) ── */}
        {showLegacyStatic && renderMode === "analog" && (
          <div
            className="row"
            style={{
              gap: 2,
              background: "var(--l2)",
              borderRadius: 4,
              padding: 2,
              flexShrink: 0,
            }}
          >
            <button
              type="button"
              className={"btn sm" + (engine === "static" ? " on" : "")}
              onClick={() => setEngine("static")}
              style={{ fontSize: 10, fontWeight: 600 }}
              title="Static netlist2svg rendering (ELK full layout)"
            >
              Static
            </button>
            <button
              type="button"
              className={"btn sm" + (engine === "interactive" ? " on" : "")}
              onClick={() => setEngine("interactive")}
              style={{ fontSize: 10, fontWeight: 600 }}
              title="Interactive canvas — drag devices, lock positions (persisted)"
            >
              Interactive
            </button>
          </div>
        )}

        {/* ── Hierarchy toggle: show/hide floorplan region blocks ──
            Only shown in "All" view — meaningless for individual subcircuits. */}
        {renderMode === "analog" && engine === "interactive" && !activeRegion && selectedDeviceNames.length === 0 && (
          <button
            type="button"
            className={"btn sm" + (showHierarchy ? " on" : "")}
            onClick={() => setShowHierarchy(!showHierarchy)}
            style={{ fontSize: 10, fontWeight: 600 }}
            title={showHierarchy
              ? "Hide hierarchy — expand floorplan regions back into devices"
              : "Show hierarchy — collapse floorplan regions into subcircuit blocks"}
          >
            {showHierarchy ? "Hide hierarchy" : "Show hierarchy"}
          </button>
        )}

        {/* Layout strategy selector */}
        <select
          value={layoutStrategy}
          onChange={(e) => setLayoutStrategy(e.target.value as LayoutStrategy)}
          style={{
            fontSize: 10,
            padding: "1px 4px",
            border: "1px solid var(--l2)",
            borderRadius: 3,
            background: "var(--card)",
            color: "var(--fg)",
            outline: "none",
            cursor: "pointer",
          }}
          title="ELK layout strategy — switch if rendering fails"
        >
          {LAYOUT_STRATEGIES.map((s) => (
            <option key={s.value} value={s.value} title={s.desc}>
              {s.label}
            </option>
          ))}
        </select>

        {/* Layout direction selector */}
        <select
          value={layoutDirection}
          onChange={(e) => setLayoutDirection(e.target.value as LayoutDirection)}
          style={{
            fontSize: 10,
            padding: "1px 4px",
            border: "1px solid var(--l2)",
            borderRadius: 3,
            background: "var(--card)",
            color: "var(--fg)",
            outline: "none",
            cursor: "pointer",
          }}
          title="ELK layout direction — controls signal flow and power rail placement"
        >
          {LAYOUT_DIRECTIONS.map((d) => (
            <option key={d.value} value={d.value} title={d.desc}>
              {d.label}
            </option>
          ))}
        </select>

        {/* Compaction level selector (BRANDES_KOEPF only) */}
        {layoutStrategy === "BRANDES_KOEPF" && (
          <select
            value={compactionLevel}
            onChange={(e) => setCompactionLevel(Number(e.target.value) as CompactionLevel)}
            style={{
              fontSize: 10,
              padding: "1px 4px",
              border: "1px solid var(--l2)",
              borderRadius: 3,
              background: "var(--card)",
              color: "var(--fg)",
              outline: "none",
              cursor: "pointer",
            }}
            title="ELK post-compaction — 0=off, 4=max, 2=default stable"
          >
            {COMPACTION_LEVELS.map((c) => (
              <option key={c.value} value={c.value} title={c.desc}>
                {c.label}
              </option>
            ))}
          </select>
        )}

        {/* Settings — fine ELK tuning */}
        <button
          type="button"
          className="btn sm"
          onClick={() => setSettingsOpen(true)}
          style={{ fontSize: 10, fontWeight: 600 }}
          title="Netlist render settings — spacing, edge behavior, compaction"
        >
          ⚙
        </button>

        {/* Separator */}
        <span style={{ width: 1, height: 16, background: "var(--l2)", flexShrink: 0 }} />

        {/* Zoom controls + downloads — static netlist2svg only */}
        {showLegacyStatic && (
        <>
        {/* Zoom controls */}
        <span style={{ width: 1, height: 16, background: "var(--l2)", flexShrink: 0 }} />
        <button
          type="button"
          className="btn sm"
          onClick={() => n2sRef.current?.zoomIn()}
          style={{ fontSize: 10, fontWeight: 600 }}
          title="Zoom in"
        >
          +
        </button>
        <button
          type="button"
          className="btn sm"
          onClick={() => n2sRef.current?.zoomOut()}
          style={{ fontSize: 10, fontWeight: 600 }}
          title="Zoom out"
        >
          −
        </button>
        <button
          type="button"
          className="btn sm"
          onClick={() => n2sRef.current?.zoomReset()}
          style={{ fontSize: 10 }}
          title="Reset zoom to 1:1"
        >
          ⊖
        </button>

        {/* Separator */}
        <span style={{ width: 1, height: 16, background: "var(--l2)", flexShrink: 0 }} />

        {/* Download buttons */}
          <button
            type="button"
            className="btn sm"
            onClick={() => handleDownload("svg")}
            style={{ fontSize: 10 }}
            title="Download SVG (black on white, for documents)"
          >
            ↓ SVG
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() => handleDownload("png")}
            style={{ fontSize: 10 }}
            title="Download PNG (black on white, 2x resolution)"
          >
            ↓ PNG
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() => handleDownload("json")}
            style={{ fontSize: 10 }}
            title="Download Yosys JSON (netlist2svg input, for debugging)"
          >
            ↓ JSON
          </button>
        </>
        )}

        {/* Hierarchical region buttons (analog mode only) */}
        {!isManual && renderMode === "analog" && hierarchical && regionIds.length > 0 && (
          <>
            {/* "All" button (flat view) */}
            <button
              type="button"
              className={"btn sm" + (!activeRegion ? " on" : "")}
              onClick={() => handleSelectRegion("")}
              style={{ fontSize: 10, fontWeight: 600 }}
            >
              All
            </button>
            {regionIds.map((id) => {
              const reg = views.perRegion.get(id)!;
              const active = id === activeRegion;
              return (
                <button
                  key={id}
                  type="button"
                  className={"btn sm" + (active ? " on" : "")}
                  onClick={() => handleSelectRegion(id)}
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <span>{reg.name}</span>
                  <span style={{ fontSize: 9, opacity: 0.6 }}>
                    {reg.result.totalDevices} devices
                  </span>
                </button>
              );
            })}
          </>
        )}
      </div>

      {/* ── Schematic canvas ──────────────────────────────────── */}
      <div
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          position: "relative",
        }}
      >
        {renderMode === "functional" ? (
          // ── Functional block diagram ─────────────────────────
          blockDiagramJson && functionalAvail ? (
            <Netlist2SvgView
              ref={n2sRef}
              netlistJson={blockDiagramJson}
              layoutStrategy={layoutStrategy}
              layoutDirection={layoutDirection}
              compactionLevel={compactionLevel}
            />
          ) : (
            <EmptyView message="No regions to show in block diagram" />
          )
        ) : (
          // ── Analog schematic ─────────────────────────────────
          engine === "interactive" ? (
            <InteractiveAnalogSchematic
              devices={interactiveDevicesWithHierarchy}
              namedNets={effectiveN2s.namedNets}
              ioNetIds={interactiveIoNetIds}
              scopeKey={interactiveScopeKey(dieId, moduleName, interactiveScope)}
              vdd={spiceConfig?.vdd ?? "VDD"}
              gnd={spiceConfig?.gnd ?? "GND"}
              layoutStrategy={layoutStrategy}
              layoutDirection={layoutDirection}
              compactionLevel={compactionLevel}
              nodeNode={nodeNode}
              betweenLayers={betweenLayers}
              edgeEdge={edgeEdge}
              edgeNode={edgeNode}
              favorStraightEdges={favorStraightEdges}
              dragMode={dragMode}
              blocks={hierarchyBlocks}
              onOpenBlock={handleOpenBlock}
              regionPins={regionPins}
            />
          ) : currentN2sJson ? (
            <Netlist2SvgView ref={n2sRef} netlistJson={currentN2sJson} layoutStrategy={layoutStrategy} layoutDirection={layoutDirection} compactionLevel={compactionLevel} />
          ) : (
            <EmptyView hasRegions={regionIds.length > 0} />
          )
        )}
      </div>

      {/* Render settings modal */}
      <NetlistSettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        layoutStrategy={layoutStrategy}
        setLayoutStrategy={setLayoutStrategy}
        layoutDirection={layoutDirection}
        setLayoutDirection={setLayoutDirection}
        compactionLevel={compactionLevel}
        setCompactionLevel={setCompactionLevel}
        nodeNode={nodeNode}
        setNodeNode={setNodeNode}
        betweenLayers={betweenLayers}
        setBetweenLayers={setBetweenLayers}
        edgeEdge={edgeEdge}
        setEdgeEdge={setEdgeEdge}
        edgeNode={edgeNode}
        setEdgeNode={setEdgeNode}
        favorStraightEdges={favorStraightEdges}
        setFavorStraightEdges={setFavorStraightEdges}
        showIoPins={showIoPins}
        setShowIoPins={setShowIoPins}
        showHierarchy={showHierarchy}
        setShowHierarchy={setShowHierarchy}
        showLegacyStatic={showLegacyStatic}
        setShowLegacyStatic={setShowLegacyStatic}
        dragMode={dragMode}
        setDragMode={setDragMode}
      />
    </div>
  );
}

// ── Empty view ──────────────────────────────────────────────────

// ── Utility ────────────────────────────────────────────────────

/** Stable short hash of an assistant fragment's device list — used as
 *  the interactive scope slot key so each fragment persists its own
 *  layout. djb2, deterministic across sessions. */
function hashFragmentScope(names: string[]): string {
  const s = [...names].sort().join("|");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function EmptyView({ hasRegions, message }: { hasRegions?: boolean; message?: string }) {
  const text = message ?? (hasRegions ? "Select a region" : "No analog devices found");
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        color: "var(--ink3)",
        fontStyle: "italic",
        fontSize: 12,
      }}
    >
      {text}
    </div>
  );
}

// ── Helpers (duplicated from spiceTSFormat.ts to avoid import cycle) ──

import type { AnalogDevice } from "shared";

function deviceInRegion(
  d: AnalogDevice,
  region: FloorplanRegion,
): boolean {
  const bb = d.bbox;
  if (!bb) return false;
  const cx = bb.x + bb.width / 2;
  const cy = bb.y + bb.height / 2;

  const pts = region.geometry;
  if (pts.length < 2) return false;

  if (region.kind === "rect" && pts.length >= 2) {
    const minX = Math.min(pts[0].x, pts[1].x);
    const maxX = Math.max(pts[0].x, pts[1].x);
    const minY = Math.min(pts[0].y, pts[1].y);
    const maxY = Math.max(pts[0].y, pts[1].y);
    return cx >= minX && cx <= maxX && cy >= minY && cy <= maxY;
  }

  if (pts.length >= 3) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y;
      const xj = pts[j].x, yj = pts[j].y;
      if ((yi > cy) !== (yj > cy) &&
          cx < ((xj - xi) * (cy - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  return false;
}
