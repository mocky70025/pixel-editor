export const SYNC_PORT = 17321;
export const SYNC_URL = `ws://127.0.0.1:${SYNC_PORT}`;

export interface ClientOpMessage {
  type: "op";
  reqId: string;
  op: string;
  args: Record<string, unknown>;
  /** Source tag. "mcp" or "gui". Used so the server can echo back without round-trip loops. */
  source: "mcp" | "gui";
}
export interface ClientGetStateMessage {
  type: "getState";
  reqId: string;
}
export type ClientMessage = ClientOpMessage | ClientGetStateMessage;

export interface ServerResultMessage {
  type: "result";
  reqId: string;
  ok: boolean;
  body?: unknown;
  error?: string;
}
/** Broadcast: full canvas state as base64-encoded RGBA bytes. */
export interface ServerStateMessage {
  type: "state";
  width: number;
  height: number;
  /** base64-encoded raw RGBA bytes */
  data: string;
  activeColor: string;
  palette: string[];
}
export type ServerMessage = ServerResultMessage | ServerStateMessage;
