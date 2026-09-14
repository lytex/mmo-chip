import { useCallback, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { BrandMark, Ic } from "../../icons";
import { useAuth } from "../../state/auth";
import { useSession } from "../../state/session";
import { OnlineUsersPanel } from "./OnlineUsersPanel";

// `die` controls how the active die is carried into the tab's URL:
//   "none"  — never (Library is the chooser)
//   "param" — path param (/die/:dieId)
//   "query" — ?die=<id> (other phases; harmless if unused yet)
const PHASE_TABS = [
  { path: "/", label: "Library", end: true, die: "none" as const },
  { path: "/die", label: "Die viewer", die: "param" as const },
  { path: "/merge", label: "Merge cells", die: "query" as const },
  { path: "/re", label: "RE cell", die: "query" as const },
  { path: "/code", label: "Code", die: "query" as const },
  { path: "/analog-netlist", label: "Netlist (Analog)", die: "query" as const },
  { path: "/spice-sim", label: "Spice Sim", die: "query" as const },
  { path: "/ic-package", label: "Pin planner", die: "query" as const }
];

function tabTarget(
  tab: (typeof PHASE_TABS)[number],
  dieId: string | null
): string {
  if (!dieId || tab.die === "none") return tab.path;
  if (tab.die === "param") return `/die/${dieId}`;
  return `${tab.path}?die=${encodeURIComponent(dieId)}`;
}

type Props = {
  breadcrumb?: string;
  meta?: string;
  savedAgo?: string;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
};

export function TopBar({ breadcrumb, meta, savedAgo, onUndo, onRedo, canUndo, canRedo }: Props) {
  const showHistory = !!(onUndo || onRedo);
  const dieId = useSession((s) => s.dieId);
  const { username, clearAuth } = useAuth();
  const navigate = useNavigate();
  const [showUserMenu, setShowUserMenu] = useState(false);

  const handleLogout = useCallback(() => {
    clearAuth();
    setShowUserMenu(false);
    navigate("/login", { replace: true });
  }, [clearAuth, navigate]);

  return (
    <div
      style={{
        height: 38,
        borderBottom: "1px solid var(--l2)",
        background: "var(--card)",
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
        gap: 14,
        flex: "0 0 auto"
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <BrandMark style={{ flex: "0 0 auto" }} />
        <div
          className="m"
          style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink)", letterSpacing: 0.6 }}
        >
          MMO<span style={{ color: "var(--ink3)" }}>·</span>CHIP-A
        </div>
      </div>
      <Divider />
      <nav className="row" style={{ gap: 0 }}>
        {PHASE_TABS.map((t) => (
          <NavLink
            key={t.path}
            to={tabTarget(t, dieId)}
            end={t.end}
            className={({ isActive }) => "tab" + (isActive ? " on" : "")}
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
      {(breadcrumb || meta) && (
        <>
          <Divider />
          <div className="row" style={{ gap: 6 }}>
            {breadcrumb && (
              <span
                className="m"
                style={{ fontSize: 11, color: "var(--ink2)", fontWeight: 500 }}
              >
                {breadcrumb}
              </span>
            )}
            {meta && (
              <span className="m" style={{ fontSize: 10.5, color: "var(--ink3)" }}>
                · {meta}
              </span>
            )}
          </div>
        </>
      )}
      <div style={{ flex: 1 }} />
      {showHistory && (
        <>
          <button
            className="btn ghost"
            title="Undo"
            onClick={onUndo}
            disabled={!onUndo || canUndo === false}
          >
            {Ic.undo}
          </button>
          <button
            className="btn ghost"
            title="Redo"
            onClick={onRedo}
            disabled={!onRedo || canRedo === false}
          >
            {Ic.redo}
          </button>
        </>
      )}
      {savedAgo && (
        <>
          {showHistory && <Divider />}
          <span className="m" style={{ fontSize: 10.5, color: "var(--ink3)" }}>
            {savedAgo}
          </span>
        </>
      )}

      <button
        className="btn ghost"
        title="Project settings (Ctrl+,)"
        onClick={() => window.dispatchEvent(new CustomEvent("toggle-settings"))}
        style={{ fontSize: 12, color: "var(--ink3)" }}
      >
        ⚙
      </button>
      <button
        className="btn ghost"
        title="Keyboard shortcuts (Ctrl+/)"
        onClick={() => window.dispatchEvent(new CustomEvent("toggle-shortcuts"))}
        style={{ fontSize: 12, fontWeight: 600, color: "var(--ink3)" }}
      >
        ?
      </button>

      {/* Online users */}
      <OnlineUsersPanel />

      {/* User menu */}
      {username && (
        <div style={{ position: "relative" }}>
          <button
            className="btn ghost"
            onClick={() => setShowUserMenu((v) => !v)}
            style={{ fontSize: 11, fontWeight: 500, gap: 4, display: "flex", alignItems: "center" }}
            title={`Signed in as ${username}`}
          >
            <span style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 18,
              height: 18,
              borderRadius: "50%",
              background: "var(--accent)",
              color: "#fff",
              fontSize: 9,
              fontWeight: 700
            }}>
              {username[0].toUpperCase()}
            </span>
            <span>{username}</span>
          </button>

          {showUserMenu && (
            <>
              <div
                style={{ position: "fixed", inset: 0, zIndex: 99 }}
                onClick={() => setShowUserMenu(false)}
              />
              <div
                style={{
                  position: "absolute",
                  right: 0,
                  top: "100%",
                  marginTop: 4,
                  background: "var(--card)",
                  border: "1px solid var(--l2)",
                  borderRadius: 6,
                  boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                  zIndex: 100,
                  minWidth: 120,
                  overflow: "hidden"
                }}
              >
                <div
                  onClick={handleLogout}
                  style={{
                    padding: "6px 12px",
                    fontSize: 11.5,
                    cursor: "pointer",
                    color: "var(--bad)"
                  }}
                  className="hover-bg"
                >
                  Sign out
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Divider() {
  return <div style={{ width: 1, height: 18, background: "var(--l2)" }} />;
}
