/**
 * FloorplanRegionPopover.tsx — Popover for editing/deleting a floorplan region.
 *
 * Shows: region name (editable), color picker, port aliases (B3), Delete button.
 * ReservedBy section is shown only when non-null.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DieAnnotations, FloorplanRegion } from "shared";
import { apiPut, apiDelete } from "../../api/client";
import { collectDieWideAnalogDevices } from "../../api/dieWideAnalog";
import { useAuth } from "../../state/auth";
import { useToast } from "../Toast";
import { useFloorplanStore } from "../../state/floorplan";
import {
  deviceInRegion,
  detectBoundaryNets,
  resolveGlobalPortAliases,
} from "../../lib/export/hierarchical";
import type { Viewport } from "../../renderer/types";

interface Props {
  region: FloorplanRegion;
  dieId: string;
  viewport: Viewport;
  annotations?: DieAnnotations;
  onClose: () => void;
  onSaved?: () => void;
}

const COLORS = [
  "#4dabf7", // blue
  "#69db7c", // green
  "#ffd43b", // yellow
  "#ff8787", // red
  "#da77f2", // purple
  "#ff922b", // orange
  "#748ffc", // indigo
  "#20c997", // teal
];

/**
 * Detect which nets are boundary nets for the region, based on
 * analog device terminals — same logic as the hierarchical netlist
 * generator.  This guarantees the popover shows exactly the ports
 * that will appear in the netlist.
 */
function detectRegionPorts(
  region: FloorplanRegion,
  annotations: DieAnnotations | undefined,
): { netName: string; netId: number }[] {
  if (!annotations) return [];

  // Compute analog devices from annotations (same as DieViewerPage)
  let devices = [];
  let namedNets = new Map<number, string>();
  try {
    const r = collectDieWideAnalogDevices(annotations as any, annotations.umPerPx ?? 1);
    devices = r.devices;
    namedNets = r.namedNets;
  } catch {
    return [];
  }

  // Find devices inside this region
  const insideDevices = devices.filter((d: any) => deviceInRegion(d, region));
  if (insideDevices.length === 0) return [];

  // Detect boundary nets
  const boundaryNets = detectBoundaryNets(insideDevices, devices);

  // Resolve net names, exclude VDD/GND
  const result: { netName: string; netId: number }[] = [];
  for (const netId of boundaryNets) {
    const rawName = namedNets.get(netId) ?? `n${netId}`;
    if (rawName === "vcc" || rawName === "gnd" ||
        rawName === "VDD" || rawName === "GND" || rawName === "VSS" ||
        rawName === "0") continue;
    result.push({ netName: rawName, netId });
  }

  return result;
}

export function FloorplanRegionPopover({
  region,
  dieId,
  viewport,
  annotations,
  onClose,
  onSaved,
}: Props) {
  const [name, setName] = useState(region.name);
  const [color, setColor] = useState(region.color || "#4dabf7");
  const [portAliases, setPortAliases] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    if (region.portAliases) {
      for (const [netIdStr, alias] of Object.entries(region.portAliases)) {
        init[`n${netIdStr}`] = alias;
      }
    }
    return init;
  });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saveWarnings, setSaveWarnings] = useState<string[]>([]);
  const upsertRegion = useFloorplanStore((s) => s.upsertRegion);
  const removeRegion = useFloorplanStore((s) => s.removeRegion);
  const selectRegion = useFloorplanStore((s) => s.selectRegion);
  const toast = useToast();
  const popoverRef = useRef<HTMLDivElement>(null);

  // ── Port detection (B3) ───────────────────────────────────
  const detectedPorts = useMemo(
    () => detectRegionPorts(region, annotations),
    [region, annotations],
  );

  const updatePortAlias = useCallback((netKey: string, value: string) => {
    setPortAliases((prev) => ({ ...prev, [netKey]: value }));
    setDirty(true);
    setSaveWarnings([]); // clear warnings when user edits
  }, []);

  const buildPortAliasesForSave = useCallback((): Record<number, string> => {
    const result: Record<number, string> = {};
    for (const [key, alias] of Object.entries(portAliases)) {
      if (!alias.trim()) continue;
      const netId = parseInt(key.slice(1), 10);
      if (!isNaN(netId)) result[netId] = alias.trim();
    }
    return result;
  }, [portAliases]);

  // Clear warnings when region changes
  useEffect(() => {
    setSaveWarnings([]);
  }, [region.id]);

  // Click outside → close
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = setTimeout(() => document.addEventListener("mousedown", handler), 50);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [onClose]);

  // Store original annotation net names when first loading, so we can
  // revert when the user clears an alias.
  const originalNetNamesRef = useRef<Map<number, string> | null>(null);
  if (originalNetNamesRef.current === null && annotations) {
    const map = new Map<number, string>();
    try {
      const r = collectDieWideAnalogDevices(annotations as any, annotations.umPerPx ?? 1);
      // Reverse map: numerical netId → annotation UUID
      const revMap = new Map<number, string>();
      for (const [uuid, numericId] of r.netIdMap) {
        revMap.set(numericId, uuid);
      }
      // Store original net names for any netId that has a port alias
      for (const netIdStr of Object.keys(region.portAliases ?? {})) {
        const netId = Number(netIdStr);
        const uuid = revMap.get(netId);
        if (uuid) {
          const annNet = annotations.nets?.find((n) => n.id === uuid);
          if (annNet) map.set(netId, annNet.name ?? `n${netId}`);
        }
      }
    } catch {}
    originalNetNamesRef.current = map;
  }

  const handleSave = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      const newAliases = buildPortAliasesForSave();
      const oldAliases = region.portAliases ?? {};

      // ── Rename annotation nets on the die (global rename) ────
      // Build reverse map: numerical netId → annotation UUID
      if (annotations && (Object.keys(newAliases).length > 0 || Object.keys(oldAliases).length > 0)) {
        try {
          const r = collectDieWideAnalogDevices(annotations as any, annotations.umPerPx ?? 1);
          const revMap = new Map<number, string>();
          for (const [uuid, numericId] of r.netIdMap) {
            revMap.set(numericId, uuid);
          }

          // ── Collision detection before renaming on the die ──
          // Collect aliases from OTHER regions already committed to the die.
          const committedAliasToNet = new Map<string, number>();
          const otherRegions = (annotations?.floorplanRegions ?? [])
            .filter((reg) => reg.id !== region.id);
          for (const reg of otherRegions) {
            if (!reg.portAliases) continue;
            for (const [nidStr, alias] of Object.entries(reg.portAliases)) {
              const nid = Number(nidStr);
              // Only register as committed if the alias is non-empty
              if (alias.trim()) committedAliasToNet.set(alias.trim(), nid);
            }
          }

          // Build map of current annotation net names on the die
          const dieNetNameToNetId = new Map<string, number>();
          for (const [uuid, numericId] of r.netIdMap) {
            const annNet = annotations.nets?.find((n) => n.id === uuid);
            if (annNet?.name) dieNetNameToNetId.set(annNet.name, numericId);
          }

          // Resolve collisions: if two different netIds want the same alias,
          // auto-suffix (_1, _2, …) for the second (and subsequent) one.
          const resolvedNewAliases: Record<number, string> = {};
          const usedNames = new Set(committedAliasToNet.keys());
          // Also pre-populate with existing die net names not from committed aliases
          for (const [name] of dieNetNameToNetId) {
            usedNames.add(name);
          }
          // Remove our OWN netIds from usedNames — we can rename ourselves
          for (const nidStr of Object.keys(newAliases)) {
            const nid = Number(nidStr);
            const committedAlias = [...committedAliasToNet.entries()]
              .find(([, id]) => id === nid);
            if (committedAlias) usedNames.delete(committedAlias[0]);
            // Also remove our own net from die names (we'll rename it)
            for (const [name, id] of dieNetNameToNetId) {
              if (id === nid) usedNames.delete(name);
            }
          }

          for (const [netIdStr, alias] of Object.entries(newAliases)) {
            const nid = Number(netIdStr);
            let resolved = alias;
            if (usedNames.has(resolved)) {
              // Someone else already has this name — suffix it
              let suffix = 1;
              while (usedNames.has(`${alias}_${suffix}`)) suffix++;
              resolved = `${alias}_${suffix}`;
              setSaveWarnings((prev) => [
                ...prev,
                `"${alias}" → "${resolved}" (конфликт имени)`
              ]);
            }
            usedNames.add(resolved);
            resolvedNewAliases[nid] = resolved;
          }

          // Collect nets to rename: added aliases + changed aliases
          const toRename: Array<{ uuid: string; newName: string }> = [];
          for (const [netId, resolvedAlias] of Object.entries(resolvedNewAliases)) {
            const nid = Number(netId);
            const oldAlias = oldAliases[nid];
            // Only rename if the alias actually changed
            if (oldAlias !== resolvedAlias) {
              const uuid = revMap.get(nid);
              if (uuid) toRename.push({ uuid, newName: resolvedAlias });
            }
          }

          // Collect nets to revert: removed aliases
          const toRevert: Array<{ uuid: string; originalName: string }> = [];
          for (const [netIdStr] of Object.entries(oldAliases)) {
            const netId = Number(netIdStr);
            if (resolvedNewAliases[netId] === undefined) {
              // Alias was cleared — revert to original if we have it
              const origName = originalNetNamesRef.current?.get(netId);
              if (origName) {
                const uuid = revMap.get(netId);
                if (uuid) toRevert.push({ uuid, originalName: origName });
              }
            }
          }

          // Execute renames and reverts
          const renamePromises: Promise<void>[] = [];
          for (const { uuid, newName } of toRename) {
            const annNet = annotations.nets?.find((n) => n.id === uuid);
            if (annNet) {
              const renamed = { ...annNet, name: newName };
              renamePromises.push(
                apiPut(`/api/dies/${dieId}/nets/${uuid}`, renamed)
                  .then(() => {})
                  .catch((e) => toast.error(`Failed to rename net ${uuid}`, e instanceof Error ? e.message : String(e)))
              );
            }
          }
          for (const { uuid, originalName } of toRevert) {
            const annNet = annotations.nets?.find((n) => n.id === uuid);
            if (annNet) {
              const reverted = { ...annNet, name: originalName };
              renamePromises.push(
                apiPut(`/api/dies/${dieId}/nets/${uuid}`, reverted)
                  .then(() => {})
                  .catch((e) => toast.error(`Failed to revert net ${uuid}`, e instanceof Error ? e.message : String(e)))
              );
            }
          }

          if (renamePromises.length > 0) {
            await Promise.all(renamePromises);
          }

          // Use resolved aliases (with suffixed collisions) for the region save
          // so the server data matches what's on the die
          const finalAliases = Object.fromEntries(
            Object.entries(resolvedNewAliases).filter(([, v]) => v.trim())
          );
          // Override newAliases for the save below
          const updated: FloorplanRegion = {
            ...region,
            name,
            color,
            createdByName: region.createdByName ?? null,
            reservedByName: region.reservedByName ?? null,
            portAliases: Object.keys(finalAliases).length > 0 ? finalAliases : undefined,
          };
          await apiPut(`/api/dies/${dieId}/floorplan/${region.id}`, updated);
          upsertRegion(updated);
          setDirty(false);
          // Reset original names ref so it picks up new state on next save
          originalNetNamesRef.current = null;
          onSaved?.();
          return; // ← early return, we already saved the region
        } catch (e) {
          toast.error("Failed to rename annotation nets", e instanceof Error ? e.message : String(e));
          // Fall through to the regular save below
        }
      }

      // ── Save the region with aliases (no die rename needed) ──
      const updated: FloorplanRegion = {
        ...region,
        name,
        color,
        createdByName: region.createdByName ?? null,
        reservedByName: region.reservedByName ?? null,
        portAliases: Object.keys(newAliases).length > 0 ? newAliases : undefined,
      };
      await apiPut(`/api/dies/${dieId}/floorplan/${region.id}`, updated);
      upsertRegion(updated);
      setDirty(false);
      // Reset original names ref so it picks up new state on next save
      originalNetNamesRef.current = null;
      onSaved?.();
    } catch (err) {
      toast.error("Failed to save floorplan region", err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [region, dieId, name, color, saving, upsertRegion, onSaved, buildPortAliasesForSave, annotations, toast]);

  const handleDelete = useCallback(async () => {
    if (deleting) return;
    setSaveWarnings([]);
    setDeleting(true);
    try {
      await apiDelete(`/api/dies/${dieId}/floorplan/${region.id}`);
      removeRegion(region.id);
      selectRegion(null);
      onSaved?.();
    } catch (err) {
      toast.error("Failed to delete floorplan region", err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }, [region.id, dieId, deleting, removeRegion, selectRegion, onSaved, toast]);

  // Compute popover position from region's first point
  const firstP = region.geometry[0] || { x: 0, y: 0 };
  const cssX = (firstP.x - viewport.originX) * viewport.zoom;
  const cssY = (firstP.y - viewport.originY) * viewport.zoom;
  const popW = 280;
  const margin = 12;
  let left = cssX + margin;
  let top = cssY - 100;
  if (left + popW > window.innerWidth - margin) {
    left = cssX - popW - margin;
  }
  left = Math.max(margin, left);
  top = Math.max(margin, top);

  return (
    <div
      ref={popoverRef}
      style={{
        position: "fixed",
        left,
        top,
        zIndex: 1000,
        background: "#2a2a2e",
        border: "1px solid #444",
        borderRadius: 8,
        padding: 12,
        minWidth: popW,
        boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        color: "#ddd",
        fontSize: 13,
      }}
    >
      {/* Name */}
      <label style={{ display: "block", marginBottom: 8 }}>
        <span style={{ fontSize: 10, color: "#888", textTransform: "uppercase", marginBottom: 2, display: "block" }}>
          Name
        </span>
        <input
          className="input"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setDirty(true);
            setSaveWarnings([]);
          }}
          placeholder="e.g. VCC_UVLO"
          style={{ width: "100%", boxSizing: "border-box" }}
        />
      </label>

      {/* Port aliases (B3) */}
      {detectedPorts.length > 0 && (
        <label style={{ display: "block", marginBottom: 10 }}>
          <span style={{ fontSize: 10, color: "#888", textTransform: "uppercase", marginBottom: 4, display: "block" }}>
            Ports ({detectedPorts.length})
          </span>
          <div style={{ maxHeight: 140, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
            {detectedPorts.map((p) => {
              const key = `n${p.netId}`;
              const alias = portAliases[key] ?? "";
              return (
                <div key={p.netId} className="row" style={{ gap: 4, alignItems: "center", fontSize: 11 }}>
                  <span style={{ color: "#aaa", minWidth: 60, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p.netName}
                  </span>
                  <span style={{ color: "#666" }}>→</span>
                  <input
                    className="input"
                    value={alias}
                    onChange={(e) => updatePortAlias(key, e.target.value)}
                    placeholder="alias (optional)"
                    style={{ flex: 1, fontSize: 11, padding: "2px 4px", minWidth: 0 }}
                  />
                </div>
              );
            })}
          </div>
        </label>
      )}

      {/* Color */}
      <label style={{ display: "block", marginBottom: 12 }}>
        <span style={{ fontSize: 10, color: "#888", textTransform: "uppercase", marginBottom: 4, display: "block" }}>
          Color
        </span>
        <span className="row" style={{ gap: 4, flexWrap: "wrap", alignItems: "center" }}>
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => {
                setColor(c);
                setDirty(true);
                setSaveWarnings([]);
              }}
              style={{
                width: 20,
                height: 20,
                borderRadius: "50%",
                background: c,
                border: c === color ? "2px solid #fff" : "2px solid transparent",
                cursor: "pointer",
                padding: 0,
              }}
            />
          ))}
          <input
            type="color"
            value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#4dabf7"}
            onChange={(e) => {
              setColor(e.target.value);
              setDirty(true);
              setSaveWarnings([]);
            }}
            title="Pick a custom color"
            style={{
              width: 28,
              height: 22,
              padding: 0,
              cursor: "pointer",
              border: "1px solid var(--l2)",
              borderRadius: 3,
              background: "none",
            }}
          />
        </span>
      </label>

      {/* Created by */}
      {region.createdByName && (
        <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>
          Created by: <strong>{region.createdByName}</strong>
          {region.createdAt && (
            <span> — {new Date(region.createdAt).toLocaleDateString()}</span>
          )}
        </div>
      )}

      {/* Reserved info (if set) */}
      {region.reservedByName && (
        <div style={{ fontSize: 11, color: "#ffd43b", marginBottom: 4 }}>
          🔒 Reserved by: <strong>{region.reservedByName}</strong>
          {region.reservedAt && (
            <span> — {new Date(region.reservedAt).toLocaleDateString()}</span>
          )}
        </div>
      )}

      {/* Reserve/Release button (multiplayer) */}
      {!region.reservedBy && (
        <div style={{ marginBottom: 8 }}>
          <button
            className="btn sm plain"
            onClick={async () => {
              try {
                const au = useAuth.getState();
                await apiPut(`/api/dies/${dieId}/floorplan/${region.id}`, {
                  ...region, name, color,
                  reservedBy: au.userId ?? null,
                  reservedByName: au.username ?? null,
                  reservedAt: new Date().toISOString(),
                });
                upsertRegion({ ...region, reservedBy: au.userId ?? null, reservedByName: au.username ?? null, reservedAt: new Date().toISOString() });
                setDirty(false);
                onSaved?.();
              } catch (err) {
                toast.error("Failed to reserve", err instanceof Error ? err.message : String(err));
              }
            }}
            disabled={saving}
          >
            🔒 Reserve
          </button>
          <span style={{ fontSize: 10, color: "#666", marginLeft: 6 }}>
            Optional — WIP indicator
          </span>
        </div>
      )}

      {/* Save warnings */}
      {saveWarnings.length > 0 && (
        <div
          style={{
            background: "#3a3100",
            border: "1px solid #665500",
            borderRadius: 6,
            padding: "6px 10px",
            marginBottom: 10,
            fontSize: 11,
            color: "#ffd43b",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 3 }}>⚠️ Conflicts</div>
          {saveWarnings.map((w, i) => (
            <div key={i}>{w}</div>
          ))}
        </div>
      )}

      {/* Actions */}
      <span className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
        <button className="btn sm plain" onClick={onClose}>
          Close
        </button>
        <button
          className="btn sm danger"
          onClick={handleDelete}
          disabled={deleting}
        >
          {deleting ? "…" : "Delete"}
        </button>
        <button
          className="btn sm accent"
          onClick={handleSave}
          disabled={saving || !dirty}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </span>
    </div>
  );
}
