import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { LibraryPage } from "./routes/LibraryPage";
import { DieViewerPage } from "./routes/DieViewerPage";
import { MergeCellsPage } from "./routes/MergeCellsPage";
import { RECellPage } from "./routes/RECellPage";
import { CodePage } from "./routes/CodePage";
import { AnalogNetlistPage } from "./routes/AnalogNetlistPage";
import { IcPackagePage } from "./routes/IcPackagePage";
import { SpiceSimulationPage } from "./routes/SpiceSimulationPage";
import { LoginPage } from "./routes/LoginPage";
import { NAV_HOTKEYS } from "./lib/hotkeys";
import { useAuth } from "./state/auth";
import { useSession } from "./state/session";
import { verify, checkAuthStatus } from "./api/auth";
import { subscribePresence } from "./api/annotationsWebSocket";

/**
 * Tab navigation routes for the number hotkeys (1–5).
 * Mirrors TopBar.tsx's PHASE_TABS layout.
 */
const TAB_ROUTES: Array<{ path: string; die: "none" | "param" | "query" }> = [
  { path: "/", die: "none" },
  { path: "/die", die: "param" },
  { path: "/merge", die: "query" },
  { path: "/re", die: "query" },
  { path: "/code", die: "query" },
  { path: "/analog-netlist", die: "query" },
  { path: "/spice-sim", die: "query" },
  { path: "/ic-package", die: "query" },
];

function tabTarget(index: number, dieId: string | null): string {
  const tab = TAB_ROUTES[index];
  if (!tab) return "/";
  if (tab.die === "none" || !dieId) return tab.path;
  if (tab.die === "param") return `/die/${encodeURIComponent(dieId)}`;
  return `${tab.path}?die=${encodeURIComponent(dieId)}`;
}

function NavigationHotkeys() {
  const navigate = useNavigate();
  const dieId = useSession((s) => s.dieId);
  const dieIdRef = useRef(dieId);
  dieIdRef.current = dieId;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input
      const tag = (e.target as Element)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Navigation: Shift+1..5 (bare digits reserved for metal layer switching)
      if (e.shiftKey) {
        const DIGIT_IDX: Record<string, number> = {
          Digit1: 1, Digit2: 2, Digit3: 3, Digit4: 4, Digit5: 5,
        };
        const idx = DIGIT_IDX[e.code];
        if (idx != null) {
          e.preventDefault();
          navigate(tabTarget(idx, dieIdRef.current));
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  return null;
}

/** Auth gate: checks if auth is needed and if the user is logged in. */
function AuthGate({ children }: { children: React.ReactNode }) {
  const { token, setAuth, clearAuth } = useAuth();
  const [ready, setReady] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const wsCleanupRef = useRef<(() => void) | null>(null);

  // Connect presence WS only after auth is resolved
  useEffect(() => {
    if (ready && !needsLogin && !wsCleanupRef.current) {
      wsCleanupRef.current = subscribePresence();
    }
    return () => {
      if (wsCleanupRef.current) {
        wsCleanupRef.current();
        wsCleanupRef.current = null;
      }
    };
  }, [ready, needsLogin]);

  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const status = await checkAuthStatus();
        if (cancelled) return;

        if (!status.authEnabled) {
          // Auth disabled — set dev identity so components that need userId/username work
          setAuth("dev-token", "dev", "dev");
          setNeedsLogin(false);
          setReady(true);
          return;
        }

        if (token) {
          try {
            const v = await verify(token);
            if (cancelled) return;
            setAuth(token, v.userId, v.username);
            setNeedsLogin(false);
            setReady(true);
            return;
          } catch {
            // Token invalid — clear and show login
            clearAuth();
          }
        }

        setNeedsLogin(true);
        setReady(true);
      } catch {
        // Can't reach server at all — show login as fallback
        setNeedsLogin(true);
        setReady(true);
      }
    }

    init();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ready) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--bg)",
          color: "var(--ink3)",
          fontSize: 12
        }}
      >
        Loading…
      </div>
    );
  }

  if (needsLogin && !token) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  if (token) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <>
      <NavigationHotkeys />
      <Routes>
        <Route
          path="/login"
          element={
            <PublicRoute>
              <LoginPage />
            </PublicRoute>
          }
        />
        <Route
          path="/"
          element={
            <AuthGate>
              <LibraryPage />
            </AuthGate>
          }
        />
        <Route
          path="/die"
          element={
            <AuthGate>
              <DieViewerPage />
            </AuthGate>
          }
        />
        <Route
          path="/die/:dieId"
          element={
            <AuthGate>
              <DieViewerPage />
            </AuthGate>
          }
        />
        <Route
          path="/merge"
          element={
            <AuthGate>
              <MergeCellsPage />
            </AuthGate>
          }
        />
        <Route
          path="/re"
          element={
            <AuthGate>
              <RECellPage />
            </AuthGate>
          }
        />
        <Route
          path="/code"
          element={
            <AuthGate>
              <CodePage />
            </AuthGate>
          }
        />
        <Route
          path="/analog-netlist"
          element={
            <AuthGate>
              <AnalogNetlistPage />
            </AuthGate>
          }
        />
        <Route
          path="/spice-sim"
          element={
            <AuthGate>
              <SpiceSimulationPage />
            </AuthGate>
          }
        />
        <Route
          path="/ic-package"
          element={
            <AuthGate>
              <IcPackagePage />
            </AuthGate>
          }
        />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </>
  );
}
