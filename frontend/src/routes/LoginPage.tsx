import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { login, register, verify } from "../api/auth";
import { useAuth } from "../state/auth";
import { BrandMark } from "../icons";
import { DesktopPageChrome } from "../desktop/desktop";

type Mode = "login" | "register";

export function LoginPage() {
  const navigate = useNavigate();
  const { token, setAuth, clearAuth } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // On mount, verify existing token
  useEffect(() => {
    if (token) {
      verify(token)
        .then(() => navigate("/", { replace: true }))
        .catch(() => clearAuth());
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const fn = mode === "login" ? login : register;
      const result = await fn(username, password);
      setAuth(result.token, result.userId, result.username);
      navigate("/", { replace: true });
    } catch (err: any) {
      setError(err?.message ?? "An error occurred");
    } finally {
      setLoading(false);
    }
  }, [mode, username, password, setAuth, navigate]);

  const toggleMode = useCallback(() => {
    setMode((m) => (m === "login" ? "register" : "login"));
    setError(null);
  }, []);

  return (
    <div
      className="dark"
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--bg)",
        color: "var(--ink)"
      }}
    >
      <DesktopPageChrome />
      {/* Brand bar — matches TopBar styling */}
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
      </div>

      {/* Login form */}
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center"
        }}
      >
        <form
          onSubmit={handleSubmit}
          style={{
            background: "var(--card)",
            border: "1px solid var(--l2)",
            borderRadius: 8,
            padding: 32,
            width: 320,
            display: "flex",
            flexDirection: "column",
            gap: 16
          }}
        >
          <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>
            {mode === "login" ? "Sign in" : "Create account"}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 11, color: "var(--ink2)", fontWeight: 500 }}>
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="alice"
              autoFocus
              autoComplete="username"
              className="input"
              style={{
                padding: "6px 10px",
                height: 30,
                fontSize: 13
              }}
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 11, color: "var(--ink2)", fontWeight: 500 }}>
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              className="input"
              style={{
                padding: "6px 10px",
                height: 30,
                fontSize: 13
              }}
            />
          </div>

          {error && (
            <div style={{ fontSize: 12, color: "var(--err)", padding: "2px 0" }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !username || !password}
            className="btn accent"
            style={{
              padding: "8px 0",
              height: 32,
              fontSize: 13,
              fontWeight: 600,
              borderRadius: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: loading || !username || !password ? "default" : "pointer"
            }}
          >
            {loading ? "..." : mode === "login" ? "Sign in" : "Create account"}
          </button>

          <div style={{ fontSize: 11.5, color: "var(--ink3)", textAlign: "center" }}>
            {mode === "login" ? (
              <>
                Don't have an account?{" "}
                <span
                  onClick={toggleMode}
                  style={{ color: "var(--accent)", cursor: "pointer" }}
                >
                  Register
                </span>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <span
                  onClick={toggleMode}
                  style={{ color: "var(--accent)", cursor: "pointer" }}
                >
                  Sign in
                </span>
              </>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
