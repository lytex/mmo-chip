import type { CSSProperties, ReactNode } from "react";

/**
 * Desktop (Electron) bridge exposed by desktop/preload.cjs.
 * Undefined in the plain web build / Vite dev — every consumer must no-op.
 */
export interface ChipDesktopBridge {
  platform: string;
  frameless: boolean;
  isDesktop: boolean;
  info: () => Promise<{
    platform: string;
    version: string;
    backendUrl: string;
    frameless: boolean;
    /** ML sidecar plugin installed into this app dir (setup_ml.ps1/.sh). */
    mlSidecar: boolean;
  }>;
  window: (action: "minimize" | "toggle-maximize" | "close") => void;
  /** State pushes from the main process (maximize toggles). */
  onState: (listener: (state: { maximized: boolean }) => void) => () => void;
}

declare global {
  interface Window {
    chipDesktop?: ChipDesktopBridge;
  }
}

export const chipDesktop: ChipDesktopBridge | null =
  typeof window !== "undefined" ? window.chipDesktop ?? null : null;

export function isDesktopApp(): boolean {
  return chipDesktop?.isDesktop === true;
}

// Frameless mode: the TopBar doubles as the title bar. Chromium keeps drag
// regions "sticky" — elements painted above a drag strip must explicitly opt
// out, so the shell flags the document and global.css carves the exceptions.
if (isDesktopApp() && typeof document !== "undefined") {
  document.body.classList.add("desktop-frameless");
}

/** Controls rendered into the frameless title bar (TopBar / page chrome). */
export function WindowControls(): ReactNode {
  if (!chipDesktop) return null;
  return (
    <div
      className="desktop-window-controls"
      style={
        {
          display: "flex",
          alignItems: "center",
          gap: 2,
          WebkitAppRegion: "no-drag"
        } as CSSProperties
      }
    >
      <ControlButton label="Minimize" title="Minimize" onClick={() => chipDesktop.window("minimize")}>
        <span style={{ display: "block", width: 10, height: 1, background: "currentColor" }} />
      </ControlButton>
      <ControlButton
        label="Maximize"
        title="Maximize / restore"
        onClick={() => chipDesktop.window("toggle-maximize")}
      >
        <span
          style={{
            display: "block",
            width: 9,
            height: 9,
            border: "1px solid currentColor",
            borderRadius: 1
          }}
        />
      </ControlButton>
      <ControlButton label="Close" title="Close" danger onClick={() => chipDesktop.window("close")}>
        <span style={{ display: "block", position: "relative", width: 10, height: 10 }}>
          <span style={{ ...CROSS_BAR(), transform: "rotate(45deg)" }} />
          <span style={{ ...CROSS_BAR(), transform: "rotate(-45deg)" }} />
        </span>
      </ControlButton>
    </div>
  );
}

function ControlButton({
  label,
  title,
  onClick,
  danger,
  children
}: {
  label: string;
  title: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      onClick={onClick}
      className="desktop-window-control"
    >
      {children}
    </button>
  );
}

function CROSS_BAR(): CSSProperties {
  return {
    position: "absolute",
    left: "50%",
    top: "50%",
    marginLeft: -5,
    width: 11,
    height: 1,
    background: "currentColor",
    display: "block"
  };
}

/**
 * Window chrome for pages that do not use AppShell/TopBar (login): a fixed
 * drag strip across the top plus the window buttons top-right.
 */
export function DesktopPageChrome(): ReactNode {
  if (!chipDesktop) return null;
  return (
    <>
      <div
        className="desktop-page-chrome-strip"
        style={{ position: "fixed", inset: "0 0 auto 0", height: 38, zIndex: 900 }}
      />
      <div style={{ position: "fixed", top: 9, right: 6, zIndex: 901 }}>
        <WindowControls />
      </div>
    </>
  );
}
