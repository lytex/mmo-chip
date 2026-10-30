/**
 * Preload: the only desktop-specific surface the web app sees.
 * A frameless window needs drag + window buttons; everything else is a
 * normal browser environment.
 */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const info = {
  platform: process.platform,
  frameless: true,
  isDesktop: true
};

contextBridge.exposeInMainWorld("chipDesktop", {
  ...info,
  /** Info resolved by the main process (version, URLs) via a handle. */
  info: () => ipcRenderer.invoke("desktop:info"),
  /** "minimize" | "toggle-maximize" | "close" */
  window: (action) => ipcRenderer.send("desktop:window", action),
  /** State pushes: window maximized toggles. */
  onState: (listener) => {
    const wrapped = (_event, state) => listener(state);
    ipcRenderer.on("desktop:state", wrapped);
    return () => ipcRenderer.removeListener("desktop:state", wrapped);
  }
});
