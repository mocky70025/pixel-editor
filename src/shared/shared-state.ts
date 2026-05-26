import { CanvasState } from "./canvas-state";
import { hexToRgba, MAX_DIM, RGBA, rgbaToHex } from "./types";
import { PNG } from "pngjs";
import * as fs from "fs";

export interface SharedState {
  canvas: CanvasState;
  activeColor: RGBA;
  palette: RGBA[];
}

export function createInitialState(): SharedState {
  return {
    canvas: new CanvasState(32, 32),
    activeColor: { r: 0, g: 0, b: 0, a: 255 },
    palette: [
      "#000000", "#ffffff", "#7f7f7f", "#c3c3c3",
      "#880015", "#ed1c24", "#ff7f27", "#fff200",
      "#22b14c", "#00a2e8", "#3f48cc", "#a349a4",
      "#b97a57", "#ffaec9", "#b5e61d", "#99d9ea",
    ].map((h) => hexToRgba(h)),
  };
}

export function parseColor(input: unknown, fallback: RGBA): RGBA {
  if (typeof input === "string") return hexToRgba(input);
  if (input && typeof input === "object") {
    const o = input as Record<string, number>;
    return {
      r: clampByte(o.r ?? 0),
      g: clampByte(o.g ?? 0),
      b: clampByte(o.b ?? 0),
      a: clampByte(o.a ?? 255),
    };
  }
  return fallback;
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.floor(n)));
}

/** Execute an operation against a shared state. Returns a JSON-serializable result body. */
export function dispatchOp(
  state: SharedState,
  op: string,
  a: Record<string, unknown>,
): Record<string, unknown> {
  const { canvas } = state;
  switch (op) {
    case "new_canvas":
      canvas.reset(Number(a.width), Number(a.height));
      return { width: canvas.width, height: canvas.height };

    case "get_canvas_info":
      return {
        width: canvas.width,
        height: canvas.height,
        activeColor: rgbaToHex(state.activeColor),
        palette: state.palette.map(rgbaToHex),
      };

    case "get_canvas_image": {
      const scale = a.scale ? Number(a.scale) : 1;
      const buf = canvas.toPNGBufferScaled(scale);
      return {
        width: canvas.width * scale,
        height: canvas.height * scale,
        base64: buf.toString("base64"),
      };
    }

    case "set_active_color":
      state.activeColor = parseColor(a.color, state.activeColor);
      return { activeColor: rgbaToHex(state.activeColor) };

    case "get_palette":
      return { palette: state.palette.map(rgbaToHex) };

    case "set_palette":
      if (!Array.isArray(a.colors)) throw new Error("colors must be an array");
      state.palette = (a.colors as string[]).map((c) => hexToRgba(c));
      return { palette: state.palette.map(rgbaToHex) };

    case "set_pixel":
      canvas.setPixel(
        Number(a.x), Number(a.y),
        a.color ? parseColor(a.color, state.activeColor) : state.activeColor,
      );
      return { x: a.x, y: a.y };

    case "get_pixel": {
      const p = canvas.getPixel(Number(a.x), Number(a.y));
      if (!p) throw new Error("Out of bounds");
      return { x: a.x, y: a.y, color: rgbaToHex(p), alpha: p.a };
    }

    case "draw_line":
      canvas.drawLine(
        Number(a.x0), Number(a.y0), Number(a.x1), Number(a.y1),
        a.color ? parseColor(a.color, state.activeColor) : state.activeColor,
      );
      return {};

    case "draw_rect":
      canvas.drawRect(
        Number(a.x0), Number(a.y0), Number(a.x1), Number(a.y1),
        a.color ? parseColor(a.color, state.activeColor) : state.activeColor,
      );
      return {};

    case "fill_rect":
      canvas.fillRect(
        Number(a.x0), Number(a.y0), Number(a.x1), Number(a.y1),
        a.color ? parseColor(a.color, state.activeColor) : state.activeColor,
      );
      return {};

    case "flood_fill":
      canvas.floodFill(
        Number(a.x), Number(a.y),
        a.color ? parseColor(a.color, state.activeColor) : state.activeColor,
      );
      return {};

    case "clear_canvas":
      canvas.clear();
      return {};

    case "save_png":
      canvas.savePNG(String(a.path), a.scale ? Number(a.scale) : 1);
      return { path: a.path };

    case "load_png":
      canvas.loadPNG(String(a.path));
      return { width: canvas.width, height: canvas.height };

    case "image_to_pixelart": {
      const buf = fs.readFileSync(String(a.path));
      const png = PNG.sync.read(buf);
      const rgba = new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength);
      canvas.loadFromImageRGBA(rgba, png.width, png.height, Number(a.width), Number(a.height));
      return { width: canvas.width, height: canvas.height };
    }

    /** Replace entire canvas data (used for paste/undo from GUI side). */
    case "replace_data": {
      const w = Number(a.width);
      const h = Number(a.height);
      if (w < 1 || h < 1 || w > MAX_DIM || h > MAX_DIM) {
        throw new Error(`Invalid dimensions: ${w}x${h}`);
      }
      const dataStr = String(a.data);
      const buf = Buffer.from(dataStr, "base64");
      canvas.reset(w, h);
      canvas.data = new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.byteLength).slice();
      return { width: canvas.width, height: canvas.height };
    }

    default:
      throw new Error(`Unknown op: ${op}`);
  }
}

/** True if the op changes the canvas pixels (so a state broadcast is needed). */
export const MUTATING_OPS = new Set([
  "new_canvas", "set_pixel", "draw_line", "draw_rect", "fill_rect",
  "flood_fill", "clear_canvas", "load_png", "image_to_pixelart", "replace_data",
]);

export function snapshotMessage(state: SharedState) {
  const buf = Buffer.from(state.canvas.data.buffer, state.canvas.data.byteOffset, state.canvas.data.byteLength);
  return {
    type: "state" as const,
    width: state.canvas.width,
    height: state.canvas.height,
    data: buf.toString("base64"),
    activeColor: rgbaToHex(state.activeColor),
    palette: state.palette.map(rgbaToHex),
  };
}
