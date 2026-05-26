import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("pixelAPI", {
  getState: () => ipcRenderer.invoke("sync:getState"),
  applyOp: (op: string, args: Record<string, unknown>) => ipcRenderer.invoke("sync:applyOp", op, args),
  onState: (cb: (snap: unknown) => void) => {
    const handler = (_e: unknown, snap: unknown) => cb(snap);
    ipcRenderer.on("sync:state", handler);
    return () => ipcRenderer.off("sync:state", handler);
  },
  savePNG: (scale: number) => ipcRenderer.invoke("file:savePNG", scale),
  loadPNG: () => ipcRenderer.invoke("file:loadPNG"),
});
