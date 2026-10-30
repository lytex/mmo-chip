/**
 * Tiny Windows launcher for the packaged mmo-chip app.
 *
 * Two machine-specific problems happen before main.js gets a chance to run:
 *
 * 1. Chromium's sandbox initialization can crash Electron (access violation,
 *    silent exit). Escape hatch: ELECTRON_DISABLE_SANDBOX env var — set here.
 * 2. ProcessSingleton creates its lock file inside the user-data dir very
 *    early; if the user profile is not writable for this process (security
 *    filters do that), Electron exits with "Lock file can not be created!".
 *    When the profile is unwritable we point --user-data-dir at a portable
 *    directory next to the app instead — Chromium honours it before main.js.
 *
 * afterPack renames Electron's mmo-chip.exe to mmo-chip-app.exe and places
 * this launcher as mmo-chip.exe, so double-clicking "mmo-chip" just works.
 * Arguments are passed through; the exit code is propagated. A short trace
 * lands in launcher-log.txt next to the app for silent-failure debugging.
 */
use std::path::PathBuf;
use std::process::Command;

fn main() {
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => std::process::exit(2),
    };
    let dir = match exe.parent() {
        Some(d) => d.to_path_buf(),
        None => std::process::exit(2),
    };
    let app = dir.join("mmo-chip-app.exe");
    if !app.exists() {
        trace(&dir, &format!("missing app exe: {}", app.display()));
        std::process::exit(2);
    }

    std::env::set_var("ELECTRON_DISABLE_SANDBOX", "1");

    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut mode = "profile";
    if !writable(&appdata_profile()) {
        let portable = dir.join("portable-data");
        if writable(&portable) {
            args.push(format!("--user-data-dir={}", portable.display()));
            mode = "portable";
        } else {
            mode = "no writable location found";
        }
    }
    trace(&dir, &format!("launching app (data: {mode}), args={args:?}"));

    let mut cmd = Command::new(&app);
    cmd.args(&args);
    match cmd.status() {
        Ok(status) => {
            trace(&dir, &format!("app exited: {:?}", status.code()));
            std::process::exit(status.code().unwrap_or(1));
        }
        Err(error) => {
            trace(&dir, &format!("spawn failed: {error}"));
            std::process::exit(1);
        }
    }
}

/// %APPDATA%\mmo-chip — the profile main.js pins anyway.
fn appdata_profile() -> PathBuf {
    let base = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_default();
    base.join("mmo-chip")
}

fn writable(dir: &PathBuf) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".write-probe");
    match std::fs::write(&probe, b"ok") {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

fn trace(dir: &std::path::Path, message: &str) {
    use std::io::Write;
    let file = dir.join("launcher-log.txt");
    if let Ok(mut handle) = std::fs::OpenOptions::new().create(true).append(true).open(file) {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(handle, "[{stamp}] {message}");
    }
}
