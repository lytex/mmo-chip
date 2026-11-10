import { describe, it, expect, beforeEach } from "vitest";
import {
  useInteractiveSchematic,
  effectivePositions,
  lockedMap,
  orientationMap,
  scopeKey,
} from "./interactiveSchematic";

const S1 = "dieA:mod1:full";
const S2 = "dieA:mod1:fragment:abc";

beforeEach(() => {
  useInteractiveSchematic.setState({ layouts: {}, draft: null });
});

describe("drag draft → commit", () => {
  it("draft positions apply on dragEnd and survive in layouts", () => {
    const st = useInteractiveSchematic.getState();
    st.dragBegin(S1);
    st.dragMove("M_1", { x: 10, y: 20 });
    // During drag: draft visible via effectivePositions, layouts untouched
    expect(effectivePositions(useInteractiveSchematic.getState(), S1)["M_1"]).toEqual({ x: 10, y: 20 });
    useInteractiveSchematic.getState().dragEnd();
    expect(useInteractiveSchematic.getState().layouts[S1].positions["M_1"]).toEqual({ x: 10, y: 20 });
    expect(useInteractiveSchematic.getState().draft).toBeNull();
  });

  it("second device keeps first device's committed position", () => {
    const st = useInteractiveSchematic.getState();
    st.dragBegin(S1);
    st.dragMove("M_1", { x: 1, y: 2 });
    st.dragEnd();
    st.dragBegin(S1);
    st.dragMove("M_2", { x: 3, y: 4 });
    st.dragEnd();
    const pos = useInteractiveSchematic.getState().layouts[S1].positions;
    expect(pos["M_1"]).toEqual({ x: 1, y: 2 });
    expect(pos["M_2"]).toEqual({ x: 3, y: 4 });
  });

  it("dragMove without dragBegin is a no-op", () => {
    useInteractiveSchematic.getState().dragMove("M_1", { x: 9, y: 9 });
    expect(useInteractiveSchematic.getState().draft).toBeNull();
  });

  it("draft is scope-isolated", () => {
    const st = useInteractiveSchematic.getState();
    st.dragBegin(S1);
    st.dragMove("M_1", { x: 5, y: 5 });
    expect(effectivePositions(useInteractiveSchematic.getState(), S2)["M_1"]).toBeUndefined();
  });
});

describe("lock", () => {
  it("applyPositions skips locked devices", () => {
    const st = useInteractiveSchematic.getState();
    st.setLocked(S1, "M_1", true);
    st.applyPositions(S1, {
      M_1: { x: 100, y: 100 },
      M_2: { x: 50, y: 50 },
    });
    const pos = useInteractiveSchematic.getState().layouts[S1].positions;
    expect(pos["M_1"]).toBeUndefined(); // locked → ELK position dropped
    expect(pos["M_2"]).toEqual({ x: 50, y: 50 });
  });

  it("locked device keeps manual position through re-layout", () => {
    const st = useInteractiveSchematic.getState();
    st.dragBegin(S1);
    st.dragMove("M_1", { x: 7, y: 8 });
    st.dragEnd();
    st.setLocked(S1, "M_1", true);
    st.applyPositions(S1, { M_1: { x: 999, y: 999 }, M_2: { x: 1, y: 1 } });
    const pos = useInteractiveSchematic.getState().layouts[S1].positions;
    expect(pos["M_1"]).toEqual({ x: 7, y: 8 });
    expect(pos["M_2"]).toEqual({ x: 1, y: 1 });
  });

  it("setLocked(false) unlocks", () => {
    const st = useInteractiveSchematic.getState();
    st.setLocked(S1, "M_1", true);
    expect(lockedMap(useInteractiveSchematic.getState(), S1)["M_1"]).toBe(true);
    st.setLocked(S1, "M_1", false);
    expect(lockedMap(useInteractiveSchematic.getState(), S1)["M_1"]).toBe(false);
  });
});

describe("scope slots", () => {
  it("layouts of different scopes do not interfere", () => {
    const st = useInteractiveSchematic.getState();
    st.applyPositions(S1, { M_1: { x: 1, y: 1 } });
    st.applyPositions(S2, { M_1: { x: 2, y: 2 } });
    expect(useInteractiveSchematic.getState().layouts[S1].positions["M_1"]).toEqual({ x: 1, y: 1 });
    expect(useInteractiveSchematic.getState().layouts[S2].positions["M_1"]).toEqual({ x: 2, y: 2 });
  });

  it("resetScope clears only its own scope", () => {
    const st = useInteractiveSchematic.getState();
    st.applyPositions(S1, { M_1: { x: 1, y: 1 } });
    st.applyPositions(S2, { M_1: { x: 2, y: 2 } });
    st.resetScope(S1);
    expect(useInteractiveSchematic.getState().layouts[S1].positions).toEqual({});
    expect(useInteractiveSchematic.getState().layouts[S2].positions["M_1"]).toEqual({ x: 2, y: 2 });
  });

  it("pruneScope drops orphans, keeps valid entries", () => {
    const st = useInteractiveSchematic.getState();
    st.applyPositions(S1, { M_1: { x: 1, y: 1 }, GONE: { x: 9, y: 9 } });
    st.setLocked(S1, "M_1", true);
    st.setLocked(S1, "GONE", true);
    st.pruneScope(S1, ["M_1", "M_2"]);
    const lay = useInteractiveSchematic.getState().layouts[S1];
    expect(Object.keys(lay.positions)).toEqual(["M_1"]);
    expect(Object.keys(lay.locked)).toEqual(["M_1"]);
  });

  // Regression for the project-hang bug: pre-validation persisted scopes
  // may hold ±Infinity/NaN positions from ELK's scanline bug. pruneScope
  // (called on every mount / dataset change) must sanitize them.
  it("pruneScope drops non-finite positions", () => {
    const st = useInteractiveSchematic.getState();
    st.applyPositions(S1, {
      GOOD: { x: 1, y: 1 },
      INF: { x: Infinity, y: 3 },
      NEG_INF: { x: 2, y: -Infinity },
      NAN: { x: NaN, y: 4 },
    });
    st.pruneScope(S1, ["GOOD", "INF", "NEG_INF", "NAN"]);
    const positions = useInteractiveSchematic.getState().layouts[S1].positions;
    expect(positions.GOOD).toEqual({ x: 1, y: 1 });
    expect(positions.INF).toBeUndefined();
    expect(positions.NEG_INF).toBeUndefined();
    expect(positions.NAN).toBeUndefined();
  });

  it("pruneScope with no orphans keeps state identity (no write)", () => {
    const st = useInteractiveSchematic.getState();
    st.applyPositions(S1, { M_1: { x: 1, y: 1 } });
    const before = useInteractiveSchematic.getState().layouts;
    st.pruneScope(S1, ["M_1"]);
    expect(useInteractiveSchematic.getState().layouts).toBe(before);
  });
});

describe("scopeKey", () => {
  it("composes die:module:scope", () => {
    expect(scopeKey("die1", "top", "full")).toBe("die1:top:full");
    expect(scopeKey(null, "top", "region:r1")).toBe("nodie:top:region:r1");
  });
});

describe("orientation", () => {
  it("defaults to rot 0 / flip none and tolerates missing orientation", () => {
    const st = useInteractiveSchematic.getState();
    st.applyPositions(S1, { M_1: { x: 5, y: 6 } });
    expect(orientationMap(useInteractiveSchematic.getState(), S1)).toEqual({});
  });

  it("setOrientation persists per scope and survives prune", () => {
    const st = useInteractiveSchematic.getState();
    st.setOrientation(S1, "M_1", { rot: 90, flip: "none" });
    st.setOrientation(S1, "M_2", { rot: 180, flip: "h" });
    expect(orientationMap(useInteractiveSchematic.getState(), S1)).toEqual({
      M_1: { rot: 90, flip: "none" },
      M_2: { rot: 180, flip: "h" },
    });
    st.pruneScope(S1, ["M_1"]);
    expect(orientationMap(useInteractiveSchematic.getState(), S1)).toEqual({
      M_1: { rot: 90, flip: "none" },
    });
  });

  it("orientation slots are scope-isolated", () => {
    const st = useInteractiveSchematic.getState();
    st.setOrientation(S1, "M_1", { rot: 90, flip: "none" });
    expect(orientationMap(useInteractiveSchematic.getState(), S2)).toEqual({});
  });

  it("applyPositions keeps orientations untouched", () => {
    const st = useInteractiveSchematic.getState();
    st.setOrientation(S1, "M_1", { rot: 270, flip: "v" });
    st.applyPositions(S1, { M_1: { x: 1, y: 1 } });
    expect(orientationMap(useInteractiveSchematic.getState(), S1)).toEqual({
      M_1: { rot: 270, flip: "v" },
    });
  });

  it("resetScope clears orientations too", () => {
    const st = useInteractiveSchematic.getState();
    st.setOrientation(S1, "M_1", { rot: 90, flip: "h" });
    st.resetScope(S1);
    expect(orientationMap(useInteractiveSchematic.getState(), S1)).toEqual({});
  });
});

describe("undo / redo", () => {
  beforeEach(() => {
    useInteractiveSchematic.setState({ layouts: {}, draft: null, history: {} });
  });

  it("undos a drag commit back to the pre-drag layout", () => {
    const st = useInteractiveSchematic.getState();
    st.dragBegin(S1);
    st.dragMove("M_1", { x: 10, y: 20 });
    st.dragEnd();
    expect(useInteractiveSchematic.getState().layouts[S1].positions.M_1).toEqual({ x: 10, y: 20 });

    st.undo(S1);
    expect(useInteractiveSchematic.getState().layouts[S1].positions.M_1).toBeUndefined();
  });

  it("re-applies the committed drag after undo → redo", () => {
    const st = useInteractiveSchematic.getState();
    st.dragBegin(S1);
    st.dragMove("M_1", { x: 10, y: 20 });
    st.dragEnd();
    st.undo(S1);
    st.redo(S1);
    expect(useInteractiveSchematic.getState().layouts[S1].positions.M_1).toEqual({ x: 10, y: 20 });
  });

  it("undo after applyPositions (re-arrange) restores the previous arrangement", () => {
    const st = useInteractiveSchematic.getState();
    st.applyPositions(S1, { M_1: { x: 5, y: 5 } });
    st.applyPositions(S1, { M_1: { x: 9, y: 9 } });
    st.undo(S1);
    expect(useInteractiveSchematic.getState().layouts[S1].positions.M_1).toEqual({ x: 5, y: 5 });
    st.undo(S1);
    expect(useInteractiveSchematic.getState().layouts[S1].positions.M_1).toBeUndefined();
  });

  it("undo/redo respect orientation and locked too", () => {
    const st = useInteractiveSchematic.getState();
    st.setOrientation(S1, "M_1", { rot: 90, flip: "none" });
    st.undo(S1);
    expect(orientationMap(useInteractiveSchematic.getState(), S1)).toEqual({});
    st.redo(S1);
    expect(orientationMap(useInteractiveSchematic.getState(), S1)).toEqual({ M_1: { rot: 90, flip: "none" } });
  });

  it("undo on empty history is a no-op", () => {
    const st = useInteractiveSchematic.getState();
    expect(() => st.undo(S1)).not.toThrow();
    expect(useInteractiveSchematic.getState().layouts[S1]).toBeUndefined();
  });

  it("history is scope-isolated", () => {
    const st = useInteractiveSchematic.getState();
    st.applyPositions(S1, { M_1: { x: 1, y: 1 } });
    st.undo(S1);
    // S1 restored to its pre-mutation (empty) layout
    expect(useInteractiveSchematic.getState().layouts[S1]?.positions).toEqual({});
    // S2 never had history — redo is a no-op and creates no S2 entry
    st.redo(S2);
    expect(useInteractiveSchematic.getState().layouts[S2]).toBeUndefined();
  });
});

describe("seedPositions", () => {
  it("persists positions verbatim (no lock filter, no undo entry)", () => {
    const st = useInteractiveSchematic.getState();
    st.setLocked(S1, "M_1", true);
    st.seedPositions(S1, { M_1: { x: 42, y: 7 } });
    expect(useInteractiveSchematic.getState().layouts[S1].positions).toEqual({ M_1: { x: 42, y: 7 } });
    // applyPositions afterwards would normally skip locked — the seeded
    // position must survive a subsequent (locked-skipping) merge.
    st.applyPositions(S1, { M_2: { x: 1, y: 1 } });
    expect(useInteractiveSchematic.getState().layouts[S1].positions.M_1).toEqual({ x: 42, y: 7 });
    // seed does NOT push an undo entry of its own: the single undo entry
    // comes from applyPositions, restoring the seeded M_1 position.
    st.undo(S1);
    expect(useInteractiveSchematic.getState().layouts[S1].positions).toEqual({ M_1: { x: 42, y: 7 } });
  });

  // Regression for the project-hang bug: scopes persisted before ELK
  // layout results were validated could contain ±Infinity/NaN positions
  // (ELK scanline-compaction bug silently returned garbage). The store
  // must never seed/persist such coordinates — a later drag-time local
  // re-route rasterizes segments from them and used to hang forever.
  it("drops non-finite coordinates when seeding", () => {
    const st = useInteractiveSchematic.getState();
    st.seedPositions(S1, {
      A: { x: 10, y: 20 },
      B: { x: Infinity, y: 5 },
      C: { x: NaN, y: 5 },
      D: { x: 3, y: -Infinity },
    });
    const positions = useInteractiveSchematic.getState().layouts[S1].positions;
    expect(positions.A).toEqual({ x: 10, y: 20 });
    expect(positions.B).toBeUndefined();
    expect(positions.C).toBeUndefined();
    expect(positions.D).toBeUndefined();
  });
});
