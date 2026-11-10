import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useImportDie, useImportProject, useOpenProjectFolder } from "../api/dies";
import { FolderPicker } from "../components/library/FolderPicker";
import { useLibraryItems, type LibraryItem } from "../api/library";
import { AppShell } from "../components/shell/AppShell";
import { StatusBar } from "../components/shell/StatusBar";
import { ThumbCard } from "../components/library/ThumbCard";
import { Ic } from "../icons";
import { usePageStatus } from "../lib/useUserStatus";
import { useToast } from "../components/Toast";
import { useDialog } from "../components/Dialog";
import { useProjectTransfer, type ProjectTransfer } from "../state/projectTransfer";

export function LibraryPage() {
  const { items, isLoading, error, refetch } = useLibraryItems();
  usePageStatus(null);
  const importMutation = useImportDie();
  const importProjectMutation = useImportProject();
  const openFolderMutation = useOpenProjectFolder();
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  // When set, the folder picker is choosing a destination for an import.
  const [importIntoFolder, setImportIntoFolder] = useState<
    "image" | "project" | null
  >(null);
  const pendingFolderRef = useRef<string | null>(null);
  const toast = useToast();
  const dialog = useDialog();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectFileInputRef = useRef<HTMLInputElement>(null);
  const folderImageInputRef = useRef<HTMLInputElement>(null);
  const folderProjectInputRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState("");
  const transfer = useProjectTransfer((state) => state.transfer);

  const filtered = useMemo(() => filterItems(items, filter), [items, filter]);

  const totals = useMemo(() => {
    let importing = 0;
    let tiling = 0;
    for (const it of items) {
      if (it.kind === "importing") importing += 1;
      else if (it.die.tileProgress) tiling += 1;
    }
    return { importing, tiling, total: items.length };
  }, [items]);

  function handleImportClick() {
    fileInputRef.current?.click();
  }

  function startFolderImport(purpose: "image" | "project") {
    setImportIntoFolder(purpose);
    setFolderPickerOpen(true);
  }

  const handleFolderPickedForImport = useCallback((path: string) => {
    pendingFolderRef.current = path;
    setFolderPickerOpen(false);
    const purpose = importIntoFolder;
    setImportIntoFolder(null);
    if (purpose === "project") folderProjectInputRef.current?.click();
    else folderImageInputRef.current?.click();
  }, [importIntoFolder]);

  async function handleFolderImageChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    const folder = pendingFolderRef.current;
    pendingFolderRef.current = null;
    if (!file || !folder) return;
    try {
      await importMutation.mutateAsync({ file, targetFolder: folder });
    } catch (err) {
      toast.error("Import failed", (err as Error).message);
    }
  }

  const handleFolderProjectChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      const folder = pendingFolderRef.current;
      pendingFolderRef.current = null;
      if (!file || !folder) return;
      try {
        const result = await importProjectMutation.mutateAsync({ file, targetFolder: folder });
        navigate(`/die/${result.dieId}`);
      } catch (err: unknown) {
        toast.error("Import failed", (err as Error).message);
      }
    },
    [importProjectMutation, navigate, toast]
  );

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      await importMutation.mutateAsync(file);
    } catch (err) {
      toast.error("Import failed", (err as Error).message);
    }
  }

  const handleProjectFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;

      try {
        const result = await importProjectMutation.mutateAsync({ file });
        navigate(`/die/${result.dieId}`);
      } catch (err: unknown) {
        // Check for 409 conflict
        const apiErr = err as { status?: number; body?: { error?: string; dieId?: string; name?: string } };
        if (apiErr?.status === 409 && apiErr.body) {
          const b = apiErr.body;
          const action = await dialog.prompt(
            `Die "${b.name}" already exists (ID: ${b.dieId}).\nEnter a new name to import as a copy, or leave empty to cancel.\n\n(To overwrite, first delete the existing die and retry.)`
          );
          if (action && action.trim()) {
            try {
              const result2 = await importProjectMutation.mutateAsync({
                file,
                renameTo: action.trim()
              });
              navigate(`/die/${result2.dieId}`);
            } catch (err2: unknown) {
              toast.error("Import failed", (err2 as Error).message);
            }
          }
        } else {
          toast.error("Import failed", (err as Error).message);
        }
      }
    },
    [importProjectMutation, navigate]
  );

  const handleOpenFolder = useCallback(
    async (path: string) => {
      try {
        const result = await openFolderMutation.mutateAsync({ path });
        setFolderPickerOpen(false);
        if (result.renamed) {
          const detail = result.existing
            ? 'Opened "' + result.name + '" (id renamed to avoid a clash)'
            : 'Created "' + result.name + '"';
          toast.success("Project opened", detail);
        }
        navigate('/die/' + result.dieId);
      } catch (err) {
        toast.error("Could not open folder", (err as Error).message);
      }
    },
    [openFolderMutation, navigate, toast]
  );

  return (
    <AppShell>
      <div style={{ padding: "24px 24px 0", display: "flex", alignItems: "center", gap: 10 }}>
        <h1
          style={{
            margin: 0,
            fontSize: 18,
            fontWeight: 600,
            color: "var(--ink)",
            letterSpacing: -0.2
          }}
        >
          All chips
        </h1>
        <span className="m" style={{ color: "var(--ink3)", fontSize: 11 }}>
          {totals.total} total
        </span>
        <div style={{ flex: 1 }} />
        <label className="input m" style={{ width: 240 }}>
          <span style={{ color: "var(--ink3)", display: "inline-flex" }}>{Ic.search}</span>
          <input
            placeholder="filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
        {/* <!--- library-button-order ---> */}
        <button
          className="btn accent"
          onClick={handleImportClick}
          disabled={importMutation.isPending}
        >
          {Ic.plus} {importMutation.isPending ? "uploading…" : "Import image"}
        </button>
        <button
          className="btn"
          onClick={() => projectFileInputRef.current?.click()}
          disabled={importProjectMutation.isPending}
        >
          {importProjectMutation.isPending ? "importing…" : "Import Project"}
        </button>
        <button
          className="btn accent"
          onClick={() => startFolderImport("image")}
          disabled={importMutation.isPending}
          title="Import an image and create a project in a folder you choose"
        >
          {Ic.plus} {"Import image → folder"}
        </button>
        <button
          className="btn"
          onClick={() => startFolderImport("project")}
          disabled={importProjectMutation.isPending}
          title="Import a project ZIP into a folder you choose"
        >
          {"Import Project → folder"}
        </button>
        <button
          className="btn"
          onClick={() => setFolderPickerOpen(true)}
          disabled={openFolderMutation.isPending}
        >
          {Ic.folderOpen} {openFolderMutation.isPending ? "opening…" : "Open folder"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/tiff,.tif,.tiff"
          style={{ display: "none" }}
          onChange={handleFileChange}
        />
        <input
          ref={projectFileInputRef}
          type="file"
          accept=".zip"
          style={{ display: "none" }}
          onChange={handleProjectFileChange}
        />
        <input
          ref={folderImageInputRef}
          type="file"
          accept="image/png,image/jpeg,image/tiff,.tif,.tiff"
          style={{ display: "none" }}
          onChange={handleFolderImageChange}
        />
        <input
          ref={folderProjectInputRef}
          type="file"
          accept=".zip"
          style={{ display: "none" }}
          onChange={handleFolderProjectChange}
        />
      </div>

      <div
        style={{
          flex: "1 1 auto",
          overflow: "auto",
          padding: "18px 24px 24px"
        }}
      >
        {error && <ErrorState message={error.message} onRetry={() => void refetch()} />}
        {!error && isLoading && <EmptyState>loading…</EmptyState>}
        {!error && !isLoading && filtered.length === 0 && (
          <EmptyState>
            {items.length === 0
              ? "no chips yet — import a die image to get started"
              : "no matches"}
          </EmptyState>
        )}
        {!error && filtered.length > 0 && (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
              gap: 14,
              alignContent: "start"
            }}
          >
            {filtered.map((it) => (
              <ThumbCard key={it.id} {...itemProps(it)} />
            ))}
          </div>
        )}
      </div>

      <StatusBar items={buildStatusItems(totals, importMutation.error?.message, transfer)} />
      {folderPickerOpen && (
        importIntoFolder ? (
          <FolderPicker
            title="Choose a folder for the new project"
            confirmLabel="Use this folder"
            mode="create"
            onConfirm={handleFolderPickedForImport}
            onClose={() => {
              setFolderPickerOpen(false);
              setImportIntoFolder(null);
            }}
          />
        ) : (
          <FolderPicker
            title="Open project folder"
            confirmLabel="Open"
            onConfirm={handleOpenFolder}
            onClose={() => setFolderPickerOpen(false)}
          />
        )
      )}
    </AppShell>
  );
}

function itemProps(item: LibraryItem) {
  if (item.kind === "die") {
    return {
      kind: "die" as const,
      die: item.die,
      inferenceJob: item.inferenceJob
    };
  }
  return { kind: "importing" as const, job: item.job };
}

function filterItems(items: LibraryItem[], filter: string): LibraryItem[] {
  const q = filter.trim().toLowerCase();
  if (!q) return items;
  return items.filter((it) => {
    if (it.kind === "die") return it.die.name.toLowerCase().includes(q);
    return it.job.originalFilename.toLowerCase().includes(q);
  });
}

function buildStatusItems(
  totals: { total: number; importing: number; tiling: number },
  uploadError?: string,
  transfer?: ProjectTransfer | null
): React.ReactNode[] {
  const items: React.ReactNode[] = [`${totals.total} chips`];
  if (totals.importing) items.push(`${totals.importing} importing`);
  if (totals.tiling) items.push(`${totals.tiling} tiling`);
  if (!totals.importing && !totals.tiling) items.push("idle");
  if (transfer) items.push(<ProjectTransferStatus key="project-transfer" transfer={transfer} />);
  if (uploadError) items.push(`upload failed: ${uploadError}`);
  return items;
}

function ProjectTransferStatus({ transfer }: { transfer: ProjectTransfer }) {
  const knownTotal = transfer.total !== null && transfer.total > 0;
  const percent = knownTotal
    ? Math.min(100, Math.round((transfer.loaded / transfer.total!) * 100))
    : null;
  const tone = transfer.error ? "#c75c5c" : transfer.active ? "var(--accent)" : "var(--ink3)";
  const label = transfer.error
    ? `error: ${transfer.error}`
    : `${transfer.kind === "import" ? "import" : "export"}: ${transfer.phase}${percent === null ? "" : ` ${percent}%`}`;

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 190 }}>
      <span style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
      {transfer.active && (
        <span
          aria-label={label}
          style={{ width: 96, height: 4, background: "var(--l2)", borderRadius: 99, overflow: "hidden" }}
        >
          <span
            style={{
              display: "block",
              height: "100%",
              width: percent === null ? "35%" : `${Math.max(3, percent)}%`,
              background: tone,
              borderRadius: 99,
              transition: "width 160ms linear"
            }}
          />
        </span>
      )}
    </span>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="m"
      style={{
        color: "var(--ink3)",
        fontSize: 11,
        padding: "40px 0",
        textAlign: "center",
        letterSpacing: 0.4
      }}
    >
      {children}
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      style={{
        border: "1px solid var(--l2)",
        background: "var(--errBg)",
        color: "var(--err)",
        padding: "12px 14px",
        borderRadius: 3,
        display: "flex",
        alignItems: "center",
        gap: 10
      }}
    >
      <span className="m" style={{ fontSize: 11 }}>
        failed to load library: {message}
      </span>
      <div style={{ flex: 1 }} />
      <button className="btn" onClick={onRetry}>
        retry
      </button>
    </div>
  );
}
