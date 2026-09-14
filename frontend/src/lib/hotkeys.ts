/**
 * hotkeys.ts — Central keyboard shortcut registry.
 *
 * Maps keys to tool actions. One file to configure; easy to extend with a
 * GUI editor later. No modifier keys here (Ctrl/Shift are handled separately
 * for undo/redo).
 */

// ── Die Viewer hotkeys ────────────────────────────────────────

export type DieViewerToolId =
  | "select"
  | "wire"
  | "multiWire"
  | "via"
  | "viaRect"
  | "viaPoly"
  | "addCell"
  | "cellGuideLine"
  | "cellGuideSeg"
  | "ioPoint"
  | "roi"
  | "ignore"
  | "measure"
  | "pan"
  | "comment"
  | "floorplan";

export const DIE_VIEWER_HOTKEYS: Record<string, DieViewerToolId> = {
  "s": "select",
  "w": "wire",
  "b": "multiWire",
  "o": "via",
  "k": "measure",
  "r": "addCell",
  "p": "ioPoint",
  "f": "pan",       // f = fit is handled separately; pan is fallback
  "c": "comment",
  "h": "floorplan",
};

// ── Cell RE hotkeys ───────────────────────────────────────────

export type ReToolId = "select" | "pan" | "rect" | "polygon" | "point" | "polyline";

export const CELL_RE_HOTKEYS: Record<string, ReToolId> = {
  "r": "rect",
  "p": "polygon",
  "o": "point",     // o = via/contact point
  "l": "polyline",
};

// ── Global action hotkeys (no modifier) ───────────────────────

export type GlobalAction = "fitToScreen" | "zoomIn" | "zoomOut";

export const GLOBAL_HOTKEYS: Record<string, GlobalAction> = {
  "f": "fitToScreen",
  "+": "zoomIn",
  "=": "zoomIn",    // unshifted +
  "-": "zoomOut",
};

// ── Navigation hotkeys (Shift+1..5, tab switching) ─────────────
// Maps Shift+key → index into TAB_ROUTES in App.tsx.
// 0=Library, 1=Die viewer, 2=Merge cells, 3=RE cell, 4=Code, 5=Netlist (Analog)
export const NAV_HOTKEYS: Record<string, number> = {
  "1": 1,  // Shift+1 → Die viewer
  "2": 2,  // Shift+2 → Merge cells
  "3": 3,  // Shift+3 → RE cell
  "4": 4,  // Shift+4 → Code
  "5": 5,  // Shift+5 → Netlist (Analog)
};

// ── Die-viewer metal hotkeys (bare digits 1..N) ──────────────
// Maps bare digit key → metal index (0-based) into MetalStack.metals.
export const METAL_HOTKEYS: Record<string, number> = {
  "1": 0,
  "2": 1,
  "3": 2,
  "4": 3,
  "5": 4,
  "6": 5,
  "7": 6,
  "8": 7,
  "9": 8,
};

// ── Die-viewer via hotkeys (Alt+1..N) ─────────────────────────
// Maps Alt+digit key → via index (0-based) into MetalStack.vias.
export const VIA_HOTKEYS: Record<string, number> = {
  "1": 0,
  "2": 1,
  "3": 2,
  "4": 3,
  "5": 4,
  "6": 5,
  "7": 6,
  "8": 7,
  "9": 8,
};

// ── Merge Cells mode hotkeys ────────────────────────────────────
// Alt+1..Alt+5 to switch merge view mode (Alt prefix avoids conflict
// with NAV_HOTKEYS which uses bare digits for tab switching).
export type MergeModeId = "overlay" | "sxs" | "diff" | "specimen" | "candidate";

export const MERGE_HOTKEYS: Record<string, MergeModeId> = {
  "Alt+1": "overlay",
  "Alt+2": "sxs",
  "Alt+3": "diff",
  "Alt+4": "specimen",
  "Alt+5": "candidate",
};

// ── Pin Planner (IC Package) tool hotkeys ────────────────────────
// Bare keys switch the active editor tool. Stored here so the keyboard
// handler and the ShortcutsPanel helper both read the same mapping.
export type PinPlannerToolId = "pan" | "name" | "bond";

export const PIN_PLANNER_HOTKEYS: Record<string, PinPlannerToolId> = {
  "s": "pan",
  "t": "name",   // text — click a package pin to name it
  "w": "bond",   // wire/bond — click pin, then die pad
};

// ── Analog Netlist (Netlist page) hotkeys ───────────────────────
export type AnalogNetlistAction =
  | "toggleGraph"      // G — switch between Code / Graph views
  | "toggleHierarchy" // H — toggle hierarchical netlist
  | "toggleResFormat"  // R — resistor format ohms / sq·Rs
  | "toggleMatch"     // M — toggle device geometry matching
  | "viewCode"        // Alt+1 — Code view
  | "viewGraph"       // Alt+2 — Graph view
  | "viewSchematic"   // Alt+3 — Schematic view
  | "viewLvs";        // Alt+4 — LVS compare view

export const ANALOG_NETLIST_HOTKEYS: Record<string, AnalogNetlistAction> = {
  "g": "toggleGraph",
  "G": "toggleGraph",
  "h": "toggleHierarchy",
  "H": "toggleHierarchy",
  "r": "toggleResFormat",
  "R": "toggleResFormat",
  "m": "toggleMatch",
  "M": "toggleMatch",
};

/** Alt+1/2/3 view switch mappings (checked in handler via e.altKey) */
export const ANALOG_NETLIST_ALT_HOTKEYS: Record<string, AnalogNetlistAction> = {
  "1": "viewCode",
  "2": "viewGraph",
  "3": "viewSchematic",
  "4": "viewLvs",
};

// ── Die Viewer modifier-action hotkeys (Ctrl/Shift combos) ──────
// Actions that are gated on wire-draft or selection state; the
// handler logic lives in DieViewerPage.tsx but which key triggers
// which action is defined here so remapping is one file.
export type DieViewerModAction =
  | "copyCell"
  | "pasteCell"
  | "makeUnique"
  | "viaUp"
  | "viaDown"
  | "deleteAllRulers";

export const DIE_VIEWER_MOD_HOTKEYS: Record<string, {
  ctrl: boolean; shift: boolean; action: DieViewerModAction
}> = {
  "c": { ctrl: true, shift: false, action: "copyCell" },
  "C": { ctrl: true, shift: false, action: "copyCell" },
  "v": { ctrl: true, shift: false, action: "pasteCell" },
  "V": { ctrl: true, shift: false, action: "pasteCell" },
  "u": { ctrl: false, shift: true, action: "makeUnique" },
  "U": { ctrl: false, shift: true, action: "makeUnique" },
  "e": { ctrl: false, shift: false, action: "viaUp" },
  "E": { ctrl: false, shift: false, action: "viaUp" },
  "q": { ctrl: false, shift: false, action: "viaDown" },
  "Q": { ctrl: false, shift: false, action: "viaDown" },
  "k": { ctrl: false, shift: true, action: "deleteAllRulers" },
  "K": { ctrl: false, shift: true, action: "deleteAllRulers" },
};

// ── Overlay hotkeys (shared across Die viewer / Merge / RE Cell) ─
//   Space+B         — toggle base image visibility
//   ]               — cycle to next overlay (toggle on/off)
//   [               — cycle to previous overlay (toggle on/off)
//   Space+1..8       — show only overlay layer #1..#8; repeat to hide it
// These are handled by the `useOverlayHotkeys()` hook.
