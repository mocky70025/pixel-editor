#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";
import { MAX_DIM } from "../shared/types";
import { SYNC_URL } from "../shared/protocol";
import {
  createInitialState,
  dispatchOp,
  SharedState,
} from "../shared/shared-state";

const standaloneState: SharedState = createInitialState();

// ----- Remote (Electron) connection management -----
let ws: WebSocket | null = null;
let connecting: Promise<WebSocket | null> | null = null;
let nextReqId = 1;
const pending = new Map<string, (msg: { ok: boolean; body?: unknown; error?: string }) => void>();

function tryConnect(timeoutMs = 250): Promise<WebSocket | null> {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(ws);
  if (connecting) return connecting;
  connecting = new Promise((resolve) => {
    const sock = new WebSocket(SYNC_URL);
    const timer = setTimeout(() => {
      try { sock.terminate(); } catch { /* ignore */ }
      resolve(null);
    }, timeoutMs);
    sock.once("open", () => {
      clearTimeout(timer);
      ws = sock;
      resolve(sock);
    });
    sock.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    sock.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "result" && pending.has(msg.reqId)) {
          pending.get(msg.reqId)!(msg);
          pending.delete(msg.reqId);
        }
        // ignore "state" broadcasts; MCP doesn't need to render
      } catch { /* ignore */ }
    });
    sock.on("close", () => {
      if (ws === sock) ws = null;
      connecting = null;
      for (const [, fn] of pending) fn({ ok: false, error: "WS closed" });
      pending.clear();
    });
  });
  connecting.finally(() => { connecting = null; });
  return connecting;
}

async function remoteCall(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sock = await tryConnect();
  if (!sock) throw new Error("No remote connection");
  const reqId = String(nextReqId++);
  return new Promise((resolve, reject) => {
    pending.set(reqId, (msg) => {
      if (msg.ok) resolve((msg.body as Record<string, unknown>) ?? {});
      else reject(new Error(msg.error ?? "Remote error"));
    });
    sock.send(JSON.stringify({ type: "op", reqId, op, args, source: "mcp" }));
  });
}

async function execute(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sock = await tryConnect();
  if (sock) {
    try {
      const body = await remoteCall(op, args);
      return { ...body, _mode: "remote" };
    } catch (err) {
      // fall through to standalone if remote fails mid-call
      const body = dispatchOp(standaloneState, op, args);
      return { ...body, _mode: "standalone-fallback", _error: (err as Error).message };
    }
  }
  const body = dispatchOp(standaloneState, op, args);
  return { ...body, _mode: "standalone" };
}

// ----- MCP server -----

const TOOLS = [
  { name: "new_canvas", description: "Create a new blank canvas. width/height clamped to 1..128.",
    inputSchema: { type: "object", properties: { width: { type: "number", minimum: 1, maximum: MAX_DIM }, height: { type: "number", minimum: 1, maximum: MAX_DIM } }, required: ["width", "height"] } },
  { name: "get_canvas_info", description: "Return canvas width/height and active color.",
    inputSchema: { type: "object", properties: {} } },
  { name: "get_canvas_image", description: "Return the current canvas as a base64-encoded PNG.",
    inputSchema: { type: "object", properties: { scale: { type: "number", minimum: 1, maximum: 32 } } } },
  { name: "set_active_color", description: "Set the active color. Accepts hex string or {r,g,b,a}.",
    inputSchema: { type: "object", properties: { color: {} }, required: ["color"] } },
  { name: "get_palette", description: "Return the current palette as hex strings.",
    inputSchema: { type: "object", properties: {} } },
  { name: "set_palette", description: "Replace the palette. Accepts an array of hex strings.",
    inputSchema: { type: "object", properties: { colors: { type: "array", items: { type: "string" } } }, required: ["colors"] } },
  { name: "set_pixel", description: "Set a single pixel.",
    inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, color: {} }, required: ["x", "y"] } },
  { name: "get_pixel", description: "Get the color of a single pixel as hex.",
    inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } },
  { name: "draw_line", description: "Draw a line between two points.",
    inputSchema: { type: "object", properties: { x0: { type: "number" }, y0: { type: "number" }, x1: { type: "number" }, y1: { type: "number" }, color: {} }, required: ["x0", "y0", "x1", "y1"] } },
  { name: "draw_rect", description: "Draw a rectangle outline.",
    inputSchema: { type: "object", properties: { x0: { type: "number" }, y0: { type: "number" }, x1: { type: "number" }, y1: { type: "number" }, color: {} }, required: ["x0", "y0", "x1", "y1"] } },
  { name: "fill_rect", description: "Fill a rectangle.",
    inputSchema: { type: "object", properties: { x0: { type: "number" }, y0: { type: "number" }, x1: { type: "number" }, y1: { type: "number" }, color: {} }, required: ["x0", "y0", "x1", "y1"] } },
  { name: "flood_fill", description: "Flood fill connected pixels of the same color.",
    inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, color: {} }, required: ["x", "y"] } },
  { name: "clear_canvas", description: "Clear all pixels to transparent.",
    inputSchema: { type: "object", properties: {} } },
  { name: "save_png", description: "Save the canvas as a PNG to the given absolute path.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, scale: { type: "number", minimum: 1, maximum: 32 } }, required: ["path"] } },
  { name: "load_png", description: "Load a PNG (max 128x128) from the given absolute path into the canvas.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "image_to_pixelart", description: "Read an image file (PNG only) and downsample it into the canvas.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, width: { type: "number", minimum: 1, maximum: MAX_DIM }, height: { type: "number", minimum: 1, maximum: MAX_DIM } }, required: ["path", "width", "height"] } },
];

const server = new Server(
  { name: "pixel-editor", version: "0.2.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  try {
    const result = await execute(name, args);
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...result }) }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
  }
});

async function main() {
  // Try once at startup; failure is fine (standalone mode).
  await tryConnect(300);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
