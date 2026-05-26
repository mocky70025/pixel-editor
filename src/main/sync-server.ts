import { WebSocketServer, WebSocket } from "ws";
import { SYNC_PORT, ClientMessage } from "../shared/protocol";
import {
  createInitialState,
  dispatchOp,
  MUTATING_OPS,
  snapshotMessage,
  SharedState,
} from "../shared/shared-state";

export type StateListener = (state: SharedState) => void;

export class SyncServer {
  private wss: WebSocketServer | null = null;
  state: SharedState = createInitialState();
  private listeners = new Set<StateListener>();

  start(port = SYNC_PORT): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ host: "127.0.0.1", port });
      this.wss.on("listening", () => resolve());
      this.wss.on("error", (err) => reject(err));
      this.wss.on("connection", (ws) => {
        // Push current state to new client.
        ws.send(JSON.stringify(snapshotMessage(this.state)));
        ws.on("message", (raw) => {
          this.handleMessage(ws, raw.toString());
        });
      });
    });
  }

  onLocalChange(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called by Electron main when GUI mutates state locally. */
  applyLocal(op: string, args: Record<string, unknown>): Record<string, unknown> {
    const body = dispatchOp(this.state, op, args);
    if (MUTATING_OPS.has(op) || op === "set_active_color" || op === "set_palette") {
      this.broadcastState();
      this.notifyListeners();
    }
    return body;
  }

  getSnapshotMessage() {
    return snapshotMessage(this.state);
  }

  private handleMessage(ws: WebSocket, raw: string) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }
    if (msg.type === "getState") {
      ws.send(JSON.stringify({ ...snapshotMessage(this.state) }));
      ws.send(JSON.stringify({ type: "result", reqId: msg.reqId, ok: true }));
      return;
    }
    if (msg.type === "op") {
      try {
        const body = dispatchOp(this.state, msg.op, msg.args);
        ws.send(JSON.stringify({ type: "result", reqId: msg.reqId, ok: true, body }));
        if (
          MUTATING_OPS.has(msg.op) ||
          msg.op === "set_active_color" ||
          msg.op === "set_palette"
        ) {
          this.broadcastState();
          this.notifyListeners();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ws.send(JSON.stringify({ type: "result", reqId: msg.reqId, ok: false, error: message }));
      }
    }
  }

  private broadcastState() {
    if (!this.wss) return;
    const payload = JSON.stringify(snapshotMessage(this.state));
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  private notifyListeners() {
    for (const l of this.listeners) l(this.state);
  }
}
