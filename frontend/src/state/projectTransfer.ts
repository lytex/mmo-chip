import { create } from "zustand";

export type ProjectTransferKind = "import" | "export";

export type ProjectTransfer = {
  kind: ProjectTransferKind;
  phase: string;
  loaded: number;
  total: number | null;
  active: boolean;
  error: string | null;
};

type ProjectTransferStore = {
  transfer: ProjectTransfer | null;
  start: (kind: ProjectTransferKind, phase: string, total?: number | null) => void;
  update: (patch: Partial<Pick<ProjectTransfer, "phase" | "loaded" | "total">>) => void;
  complete: (phase: string) => void;
  fail: (message: string) => void;
  clear: () => void;
};

export const useProjectTransfer = create<ProjectTransferStore>((set) => ({
  transfer: null,
  start: (kind, phase, total = null) => {
    set({
      transfer: {
        kind,
        phase,
        loaded: 0,
        total,
        active: true,
        error: null
      }
    });
  },
  update: (patch) => {
    set((state) => (state.transfer ? { transfer: { ...state.transfer, ...patch } } : state));
  },
  complete: (phase) => {
    set((state) =>
      state.transfer
        ? {
            transfer: {
              ...state.transfer,
              phase,
              loaded: state.transfer.total ?? state.transfer.loaded,
              active: false
            }
          }
        : state
    );
  },
  fail: (message) => {
    set((state) =>
      state.transfer
        ? { transfer: { ...state.transfer, phase: "Transfer failed", active: false, error: message } }
        : state
    );
  },
  clear: () => set({ transfer: null })
}));
