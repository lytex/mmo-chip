import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryOptions
} from "@tanstack/react-query";
import type {
  DieMetadata,
  DieSummary,
  DieTileInfo,
  DieTileProgress,
  DieUpdateRequest,
  FsBrowseResponse,
  ImportJob,
  OpenFolderResponse,
  OverlayTileProgress
} from "shared";
import { ApiError, apiDelete, apiGet, apiPatch, apiPost, apiPut, apiUpload, authHeaders } from "./client";
import { useProjectTransfer } from "../state/projectTransfer";
import { importJobKeys } from "./importJobs";
import { usePreferences } from "../state/preferences";

export const dieKeys = {
  all: ["dies"] as const,
  list: () => [...dieKeys.all, "list"] as const,
  detail: (id: string) => [...dieKeys.all, "detail", id] as const,
  tileInfo: (id: string) => [...dieKeys.all, "tile-info", id] as const
};

export function listDies(signal?: AbortSignal): Promise<DieSummary[]> {
  return apiGet<DieSummary[]>("/api/dies", signal);
}

export function getDie(dieId: string, signal?: AbortSignal): Promise<DieMetadata> {
  return apiGet<DieMetadata>(`/api/dies/${dieId}`, signal);
}

export function getDieTileInfo(dieId: string, signal?: AbortSignal): Promise<DieTileInfo> {
  return apiGet<DieTileInfo>(`/api/dies/${dieId}/tile-info`, signal);
}

type DieQueryOptions = Omit<
  UseQueryOptions<DieMetadata, Error, DieMetadata, ReturnType<typeof dieKeys.detail>>,
  "queryKey" | "queryFn"
>;

export function useDie(dieId: string | undefined, options?: DieQueryOptions) {
  return useQuery({
    queryKey: dieKeys.detail(dieId ?? ""),
    queryFn: ({ signal }) => getDie(dieId!, signal),
    enabled: !!dieId,
    ...options
  });
}

export function useDieTileInfo(dieId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: dieKeys.tileInfo(dieId ?? ""),
    queryFn: ({ signal }) => getDieTileInfo(dieId!, signal),
    enabled: Boolean(dieId) && enabled,
    staleTime: 5_000
  });
}

/** Set die properties (cell library / scale); `null` clears one. */
export function updateDie(dieId: string, patch: DieUpdateRequest): Promise<DieMetadata> {
  return apiPatch<DieMetadata>(`/api/dies/${dieId}`, patch);
}

/** Put an updated die into the detail + list caches (the list refetches in
 *  the background too). */
export function applyDieUpdate(qc: QueryClient, die: DieMetadata): void {
  qc.setQueryData(dieKeys.detail(die.id), die);
  qc.setQueryData<DieSummary[]>(dieKeys.list(), (list) =>
    list?.map((d) => {
      if (d.id !== die.id) return d;
      const next: DieSummary = { ...d };
      delete next.cellLibrary;
      delete next.cellScale;
      if (die.cellLibrary) next.cellLibrary = die.cellLibrary;
      if (die.cellScale != null) next.cellScale = die.cellScale;
      return next;
    })
  );
  void qc.invalidateQueries({ queryKey: dieKeys.list() });
}

export function useUpdateDie() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ dieId, patch }: { dieId: string; patch: DieUpdateRequest }) =>
      updateDie(dieId, patch),
    onSuccess: (die) => applyDieUpdate(qc, die)
  });
}

export function importDie(file: File, targetFolder?: string): Promise<ImportJob> {
  const form = new FormData();
  form.append("file", file);
  if (targetFolder) form.append("targetFolder", targetFolder);
  return apiUpload<ImportJob>("/api/dies/import", form);
}

export function deleteDie(dieId: string): Promise<{ ok: true }> {
  return apiDelete<{ ok: true }>(`/api/dies/${dieId}`);
}

export interface TilePrebuildActionResult {
  ok: true;
  tileProgress: DieTileProgress | null;
  overlayTileProgress?: OverlayTileProgress;
}

export function pauseTilePrebuild(dieId: string): Promise<TilePrebuildActionResult> {
  return apiPost<TilePrebuildActionResult>(`/api/dies/${dieId}/tiles/pause`, {});
}

export function resumeTilePrebuild(dieId: string): Promise<TilePrebuildActionResult> {
  return apiPost<TilePrebuildActionResult>(`/api/dies/${dieId}/tiles/resume`, {});
}

type DiesQueryOptions = Omit<
  UseQueryOptions<DieSummary[], Error, DieSummary[], ReturnType<typeof dieKeys.list>>,
  "queryKey" | "queryFn"
>;

export function useDies(options?: DiesQueryOptions) {
  return useQuery({
    queryKey: dieKeys.list(),
    queryFn: ({ signal }) => listDies(signal),
    ...options
  });
}

// useImportDie patched: takes a File or { file, targetFolder }
export function useImportDie() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: File | { file: File; targetFolder?: string }) =>
      input instanceof File ? importDie(input) : importDie(input.file, input.targetFolder),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: dieKeys.list() });
      void qc.invalidateQueries({ queryKey: importJobKeys.list() });
    }
  });
}

export function useTilePrebuildControl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ dieId, action }: { dieId: string; action: "pause" | "resume" }) =>
      action === "pause" ? pauseTilePrebuild(dieId) : resumeTilePrebuild(dieId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: dieKeys.list() });
    }
  });
}

export function useDeleteDie() {

  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteDie,
    onSuccess: (_data, dieId) => {
      void qc.invalidateQueries({ queryKey: dieKeys.list() });
      // Drop any saved viewport so its localStorage entry doesn't leak.
      usePreferences.getState().clearSavedViewport(dieId);
    }
  });
}

// ─── Rename ─────────────────────────────────────────────────────────

export async function renameDie(dieId: string, name: string): Promise<{ ok: true; name: string }> {
  return apiPut(`/api/dies/${dieId}/rename`, { name });
}

export function useRenameDie() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ dieId, name }: { dieId: string; name: string }) => renameDie(dieId, name),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: dieKeys.list() });
    }
  });
}

// ─── Folder projects ────────────────────────────────────────────────

/** Browse the server's filesystem (roots when path is omitted). */
export function browseFs(path: string | undefined, signal?: AbortSignal): Promise<FsBrowseResponse> {
  const query = path ? `?path=${encodeURIComponent(path)}` : "";
  return apiGet<FsBrowseResponse>(`/api/fs/browse${query}`, signal);
}

export function useFsBrowse(path: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["fs-browse", path ?? "__roots__"],
    queryFn: ({ signal }) => browseFs(path ?? undefined, signal),
    enabled,
    staleTime: 5_000
  });
}

/** Register (or create) a project inside an existing folder. */
export function openProjectFolder(path: string, name?: string): Promise<OpenFolderResponse> {
  return apiPost<OpenFolderResponse>("/api/dies/open-folder", { path, name });
}

export function useOpenProjectFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ path, name }: { path: string; name?: string }) => openProjectFolder(path, name),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: dieKeys.list() });
    }
  });
}

/** Point an existing folder project at its new location after a move. */
export function relocateProject(dieId: string, path: string): Promise<{ ok: true; dieId: string; path: string }> {
  return apiPost<{ ok: true; dieId: string; path: string }>(`/api/dies/${dieId}/relocate`, { path });
}

export function useRelocateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ dieId, path }: { dieId: string; path: string }) => relocateProject(dieId, path),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: dieKeys.list() });
    }
  });
}

// ─── Project export / import ────────────────────────────────────────

export interface ExportProjectResult {
  blob: Blob;
  filename: string;
}

/**
 * Export a die project as a ZIP bundle.
 * mode: "light" | "full"
 * includePreferences: if true, reads mmo-chip-preferences from localStorage and embeds it
 */
export async function exportProject(
  dieId: string,
  mode: "light" | "full",
  includePreferences: boolean,
  signal?: AbortSignal
): Promise<ExportProjectResult> {
  const preferences =
    includePreferences ? localStorage.getItem("mmo-chip-preferences") : null;
  const deviceRegistry = localStorage.getItem("mmo-chip-device-registry");
  const analogNames = localStorage.getItem("mmo-chip-analog-names");
  const transfer = useProjectTransfer.getState();
  transfer.start("export", "Preparing ZIP archive…");

  return new Promise<ExportProjectResult>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/api/dies/${dieId}/export-project`);
    request.responseType = "blob";
    request.setRequestHeader("Content-Type", "application/json");
    for (const [name, value] of Object.entries(authHeaders())) request.setRequestHeader(name, value);

    const abort = () => request.abort();
    signal?.addEventListener("abort", abort, { once: true });
    request.onprogress = (event) => {
      transfer.update({
        phase: "Downloading ZIP archive…",
        loaded: event.loaded,
        total: event.lengthComputable ? event.total : null
      });
    };
    request.onerror = () => {
      const error = new Error("Export failed: network error");
      transfer.fail(error.message);
      reject(error);
    };
    request.onabort = () => {
      const error = new DOMException("Export cancelled", "AbortError");
      transfer.fail("Export cancelled");
      reject(error);
    };
    request.onload = () => {
      signal?.removeEventListener("abort", abort);
      if (request.status < 200 || request.status >= 300) {
        // responseType is "blob" for a successful ZIP download, so responseText is
        // unavailable here. Preserve the HTTP status without attempting to read it.
        const error = new ApiError(request.status, request.statusText || `HTTP ${request.status}`, null);
        transfer.fail(error.message);
        reject(error);
        return;
      }
      transfer.complete("ZIP archive ready");
      resolve({
        blob: request.response,
        filename: request.getResponseHeader("X-Filename") || `mmochip-${dieId}.zip`
      });
    };
    request.send(JSON.stringify({ mode, preferences, deviceRegistry, analogNames }));
  });
}

export interface ImportProjectResult {
  ok: boolean;
  dieId: string;
  preferences: string | null;
  deviceRegistry: string | null;
  analogNames: string | null;
}

/**
 * Import a project ZIP bundle.
 * Returns { ok, dieId, preferences }.
 * On conflict (409) the error object has { error: "die_already_exists", dieId, name }.
 * Pass ?name=xxx to import as a copy on conflict. Also available as second arg.
 */
export async function importProject(
  file: File,
  renameTo?: string,
  targetFolder?: string
): Promise<ImportProjectResult> {
  const form = new FormData();
  form.append("file", file);

  const params = new URLSearchParams();
  if (renameTo) params.set("name", renameTo);
  if (targetFolder) params.set("folder", targetFolder);
  const query = params.toString();
  let url = "/api/dies/import-project" + (query ? `?${query}` : "");

  const transfer = useProjectTransfer.getState();
  transfer.start("import", "Uploading ZIP archive…", file.size);

  return new Promise<ImportProjectResult>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    for (const [name, value] of Object.entries(authHeaders())) request.setRequestHeader(name, value);

    request.upload.onprogress = (event) => {
      transfer.update({
        phase: "Uploading ZIP archive…",
        loaded: event.loaded,
        total: event.lengthComputable ? event.total : file.size
      });
    };
    request.upload.onload = () => {
      // The server now validates and extracts the archive sequentially. Its duration depends on
      // disk speed and image count, so keep the lower-bar indicator indeterminate instead of
      // displaying a misleading completed percentage while this work is still in progress.
      transfer.update({ phase: "Verifying and unpacking the archive on the server…", loaded: 0, total: null });
    };
    request.onerror = () => {
      const error = new Error("Import failed: network error");
      transfer.fail(error.message);
      reject(error);
    };
    request.onabort = () => {
      const error = new DOMException("Import cancelled", "AbortError");
      transfer.fail("Import cancelled");
      reject(error);
    };
    request.onload = () => {
      if (request.status < 200 || request.status >= 300) {
        const error = responseError(request.status, request.statusText, request.responseText);
        transfer.fail(error.message);
        reject(error);
        return;
      }
      try {
        const result = JSON.parse(request.responseText) as ImportProjectResult;
        transfer.complete("Import finished");
        resolve(result);
      } catch {
        const error = new Error("Import failed: invalid server response");
        transfer.fail(error.message);
        reject(error);
      }
    };
    request.send(form);
  });
}

function responseError(status: number, statusText: string, responseText: string): ApiError {
  let body: unknown = null;
  try {
    body = responseText ? JSON.parse(responseText) : null;
  } catch {
    body = responseText;
  }
  const message =
    body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : statusText || `HTTP ${status}`;
  return new ApiError(status, message, body);
}

export function useExportProject() {
  return useMutation({
    mutationFn: async ({
      dieId,
      mode,
      includePreferences
    }: {
      dieId: string;
      mode: "light" | "full";
      includePreferences: boolean;
    }) => {
      return exportProject(dieId, mode, includePreferences);
    }
  });
}

export function useImportProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      file,
      renameTo,
      targetFolder
    }: {
      file: File;
      renameTo?: string;
      targetFolder?: string;
    }) => {
      return importProject(file, renameTo, targetFolder);
    },
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: dieKeys.list() });
      // If preferences were embedded in the bundle, restore them.
      if (result.preferences) {
        try {
          localStorage.setItem("mmo-chip-preferences", result.preferences);
        } catch {
          // localStorage might be full — silently ignore
        }
      }
      // Restore device registry (instance names, overrides, identity).
      if (result.deviceRegistry) {
        try {
          localStorage.setItem("mmo-chip-device-registry", result.deviceRegistry);
        } catch {
          // silently ignore
        }
      }
      // Restore legacy analog name map.
      if (result.analogNames) {
        try {
          localStorage.setItem("mmo-chip-analog-names", result.analogNames);
        } catch {
          // silently ignore
        }
      }
    }
  });
}
