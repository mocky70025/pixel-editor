import { app, BrowserWindow, ipcMain, dialog } from "electron";
import * as path from "path";
import { SyncServer } from "./sync-server";

const sync = new SyncServer();

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: "Pixel Editor",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "../renderer/index.html"));
  if (!app.isPackaged) {
    win.webContents.openDevTools({ mode: "detach" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (win.webContents as any).on("console-message", (...a: unknown[]) => {
      console.log("[renderer]", ...a.slice(1));
    });
  }
  win.webContents.on("render-process-gone", (_e, details) => {
    console.error("[renderer crashed]", details);
  });

  // Push state updates to the renderer.
  const unsubscribe = sync.onLocalChange(() => {
    win.webContents.send("sync:state", sync.getSnapshotMessage());
  });
  win.on("closed", unsubscribe);
  return win;
}

app.whenReady().then(async () => {
  try {
    await sync.start();
    console.log(`[sync] listening on ws://127.0.0.1:17321`);
  } catch (err) {
    console.error("[sync] failed to start:", err);
  }

  ipcMain.handle("sync:getState", () => sync.getSnapshotMessage());

  ipcMain.handle("sync:applyOp", (_e, op: string, args: Record<string, unknown>) => {
    try {
      const body = sync.applyLocal(op, args);
      return { ok: true, body };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle("file:savePNG", async (_e, scale: number) => {
    const res = await dialog.showSaveDialog({
      defaultPath: "pixel-art.png",
      filters: [{ name: "PNG", extensions: ["png"] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    sync.state.canvas.savePNG(res.filePath, scale);
    return { ok: true, path: res.filePath };
  });

  ipcMain.handle("file:loadPNG", async () => {
    const res = await dialog.showOpenDialog({
      filters: [{ name: "PNG", extensions: ["png"] }],
      properties: ["openFile"],
    });
    if (res.canceled || res.filePaths.length === 0) return { ok: false, canceled: true };
    sync.applyLocal("load_png", { path: res.filePaths[0] });
    return { ok: true, path: res.filePaths[0] };
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
