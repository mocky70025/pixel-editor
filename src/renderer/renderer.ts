// ====================================================================
// Pixel Editor renderer
// ====================================================================

interface PixelAPI {
  getState: () => Promise<StateSnap>;
  applyOp: (op: string, args: Record<string, unknown>) => Promise<{ ok: boolean; body?: unknown; error?: string }>;
  onState: (cb: (snap: StateSnap) => void) => () => void;
  savePNG: (scale: number) => Promise<{ ok: boolean; path?: string; canceled?: boolean }>;
  loadPNG: () => Promise<{ ok: boolean; canceled?: boolean; path?: string }>;
}
interface StateSnap { type: "state"; width: number; height: number; data: string; activeColor: string; palette: string[]; }
const api: PixelAPI = (window as unknown as { pixelAPI: PixelAPI }).pixelAPI;

type Tool = "pen" | "eraser" | "line" | "rect" | "fillRect" | "ellipse" | "fillEllipse" | "bucket" | "picker" | "select" | "move";
interface RGBA { r: number; g: number; b: number; a: number }
interface Rect { x0: number; y0: number; x1: number; y1: number }

const ERASE: RGBA = { r: 0, g: 0, b: 0, a: 0 };
const HISTORY_MAX = 50;

// ====================================================================
// Icons (SVG paths)
// ====================================================================
const ICONS: Record<string, string> = {
  pen: '<path d="M3 17l4-1L17 6l-3-3L4 13l-1 4z" fill="currentColor"/><path d="M14 6l3 3" stroke="currentColor" stroke-width="1.2" fill="none"/>',
  eraser: '<path d="M11 3L3 11l5 5h3l8-8-5-5h-3z" fill="currentColor"/><path d="M11 11l5 5" stroke="#1b1b1b" stroke-width="1" fill="none"/>',
  line: '<path d="M3 17L17 3" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  rect: '<rect x="3.5" y="4.5" width="13" height="11" stroke="currentColor" stroke-width="1.8" fill="none"/>',
  fillRect: '<rect x="3.5" y="4.5" width="13" height="11" fill="currentColor"/>',
  ellipse: '<ellipse cx="10" cy="10" rx="6.5" ry="5" stroke="currentColor" stroke-width="1.8" fill="none"/>',
  fillEllipse: '<ellipse cx="10" cy="10" rx="6.5" ry="5" fill="currentColor"/>',
  bucket: '<path d="M5 4l5-1 7 7-7 7-5-5V4z" fill="currentColor"/><circle cx="17" cy="14" r="1.5" fill="#4a9eff"/>',
  picker: '<path d="M13 3l4 4-3 3-1-1-7 7-2 1 1-2 7-7-1-1 2-4z" fill="currentColor"/>',
  select: '<rect x="3.5" y="3.5" width="13" height="13" stroke="currentColor" stroke-width="1.5" fill="none" stroke-dasharray="2 2"/>',
  move: '<path d="M10 2v16M2 10h16M10 2l-2 2M10 2l2 2M10 18l-2-2M10 18l2-2M2 10l2-2M2 10l2 2M18 10l-2-2M18 10l-2 2" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
};

const TOOL_DEFS: { id: Tool; name: string; key: string }[] = [
  { id: "pen", name: "ペン", key: "B" },
  { id: "eraser", name: "消しゴム", key: "E" },
  { id: "line", name: "直線", key: "L" },
  { id: "rect", name: "矩形", key: "U" },
  { id: "fillRect", name: "矩形塗り", key: "Shift+U" },
  { id: "ellipse", name: "楕円", key: "O" },
  { id: "fillEllipse", name: "楕円塗り", key: "Shift+O" },
  { id: "bucket", name: "バケツ", key: "G" },
  { id: "picker", name: "スポイト", key: "I" },
  { id: "select", name: "選択", key: "M" },
];

// ====================================================================
// Default palette
// ====================================================================
const DEFAULT_PALETTE = [
  "#000000", "#3f3f3f", "#7f7f7f", "#bfbfbf", "#ffffff", "#ffaec9", "#b97a57",
  "#440000", "#880015", "#ed1c24", "#ff7f27", "#ffc90e", "#fff200", "#efe4b0",
  "#22b14c", "#0ed145", "#99d9ea", "#3f48cc", "#00a2e8", "#a349a4", "#7092be",
];

// ====================================================================
// State
// ====================================================================
const state = {
  width: 32,
  height: 32,
  pixels: new Uint8ClampedArray(32 * 32 * 4),
  tool: "pen" as Tool,
  prevTool: "pen" as Tool, // for picker temp-switch (Alt)
  primary: { r: 0, g: 0, b: 0, a: 255 } as RGBA,
  secondary: { r: 255, g: 255, b: 255, a: 255 } as RGBA,
  // viewport
  zoom: 12,
  panX: 0,
  panY: 0,
  panning: false,
  panStart: [0, 0] as [number, number],
  spaceHeld: false,
  // drag state
  drawing: false,
  rmbDown: false, // right mouse = secondary color
  startX: -1, startY: -1,
  lastX: -1, lastY: -1,
  preDragSnapshot: null as Uint8ClampedArray | null,
  penTrail: [] as [number, number][],
  // toggles
  grid: false,
  pixelPerfect: true,
  mirrorX: false,
  mirrorY: false,
  brushSize: 1,
  // selection
  selection: null as Rect | null,
  clipboard: null as { width: number; height: number; pixels: Uint8ClampedArray } | null,
  // HSV picker
  hsv: { h: 0, s: 0, v: 0 },
  // history
  undoStack: [] as { width: number; height: number; data: string }[],
  redoStack: [] as { width: number; height: number; data: string }[],
  // palette (active swatch index, -1 if none)
  paletteActive: 0,
};

// ====================================================================
// DOM
// ====================================================================
const canvasEl = document.getElementById("canvas") as HTMLCanvasElement;
const overlayEl = document.getElementById("overlay") as HTMLCanvasElement;
const ctx = canvasEl.getContext("2d")!;
const octx = overlayEl.getContext("2d")!;
const canvasArea = document.getElementById("canvas-area") as HTMLDivElement;
const canvasHost = document.getElementById("canvas-host") as HTMLDivElement;
const toolsPanel = document.getElementById("tools-panel")!;
const paletteEl = document.getElementById("palette")!;

const primaryEl = document.getElementById("color-primary") as HTMLDivElement;
const secondaryEl = document.getElementById("color-secondary") as HTMLDivElement;
const svPad = document.getElementById("sv-pad") as HTMLDivElement;
const svCursor = document.getElementById("sv-cursor") as HTMLDivElement;
const hueSlider = document.getElementById("hue-slider") as HTMLDivElement;
const hueThumb = document.getElementById("hue-thumb") as HTMLDivElement;
const rgbR = document.getElementById("rgb-r") as HTMLInputElement;
const rgbG = document.getElementById("rgb-g") as HTMLInputElement;
const rgbB = document.getElementById("rgb-b") as HTMLInputElement;
const hexInput = document.getElementById("hex-input") as HTMLInputElement;

const undoBtn = document.getElementById("btn-undo") as HTMLButtonElement;
const redoBtn = document.getElementById("btn-redo") as HTMLButtonElement;
const gridBtn = document.getElementById("btn-grid") as HTMLButtonElement;
const ppBtn = document.getElementById("btn-pp") as HTMLButtonElement;
const mxBtn = document.getElementById("btn-mirror-x") as HTMLButtonElement;
const myBtn = document.getElementById("btn-mirror-y") as HTMLButtonElement;
const wInput = document.getElementById("inp-w") as HTMLInputElement;
const hInput = document.getElementById("inp-h") as HTMLInputElement;
const newBtn = document.getElementById("btn-new") as HTMLButtonElement;
const swapBtn = document.getElementById("btn-swap") as HTMLButtonElement;

const statPos = document.getElementById("stat-pos")!;
const statColorChip = document.getElementById("stat-color-chip")!;
const statColorHex = document.getElementById("stat-color-hex")!;
const statTool = document.getElementById("stat-tool")!;
const statSize = document.getElementById("stat-size")!;
const statZoom = document.getElementById("stat-zoom")!;
const modeEl = document.getElementById("mode-indicator")!;

// ====================================================================
// Color helpers
// ====================================================================
function hexToRGBA(hex: string, a = 255): RGBA {
  const s = hex.replace(/^#/, "");
  const n = parseInt(s.length === 3 ? s.split("").map((c) => c + c).join("") : s, 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff, a };
}
function rgbaToHex(c: RGBA): string {
  const h = (v: number) => v.toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}
function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}
function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const c = v * s;
  const hh = h / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hh >= 0 && hh < 1) { r = c; g = x; }
  else if (hh < 2) { r = x; g = c; }
  else if (hh < 3) { g = c; b = x; }
  else if (hh < 4) { g = x; b = c; }
  else if (hh < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = v - c;
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

// ====================================================================
// Buffer ops
// ====================================================================
function inBounds(x: number, y: number) { return x >= 0 && y >= 0 && x < state.width && y < state.height; }
function setPxRaw(buf: Uint8ClampedArray, x: number, y: number, c: RGBA) {
  if (!inBounds(x, y)) return;
  const i = (y * state.width + x) * 4;
  buf[i] = c.r; buf[i + 1] = c.g; buf[i + 2] = c.b; buf[i + 3] = c.a;
}
function getPxRaw(buf: Uint8ClampedArray, x: number, y: number): RGBA {
  const i = (y * state.width + x) * 4;
  return { r: buf[i], g: buf[i + 1], b: buf[i + 2], a: buf[i + 3] };
}

/** Paint a single pixel with mirror; ignores brush size. */
function paintPixel(buf: Uint8ClampedArray, x: number, y: number, c: RGBA) {
  setPxRaw(buf, x, y, c);
  const w = state.width, h = state.height;
  if (state.mirrorX) setPxRaw(buf, w - 1 - x, y, c);
  if (state.mirrorY) setPxRaw(buf, x, h - 1 - y, c);
  if (state.mirrorX && state.mirrorY) setPxRaw(buf, w - 1 - x, h - 1 - y, c);
}

/** Paint a brush (square of size) at center (x,y). */
function paintBrush(buf: Uint8ClampedArray, x: number, y: number, c: RGBA) {
  const s = state.brushSize;
  if (s === 1) { paintPixel(buf, x, y, c); return; }
  const half = Math.floor(s / 2);
  for (let dy = -half; dy < s - half; dy++) {
    for (let dx = -half; dx < s - half; dx++) {
      paintPixel(buf, x + dx, y + dy, c);
    }
  }
}

function lineOn(buf: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number, c: RGBA, brush = true) {
  let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy, x = x0, y = y0;
  while (true) {
    if (brush) paintBrush(buf, x, y, c); else paintPixel(buf, x, y, c);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

function rectOn(buf: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number, c: RGBA) {
  lineOn(buf, x0, y0, x1, y0, c, false);
  lineOn(buf, x1, y0, x1, y1, c, false);
  lineOn(buf, x1, y1, x0, y1, c, false);
  lineOn(buf, x0, y1, x0, y0, c, false);
}

function fillRectOn(buf: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number, c: RGBA) {
  const [xa, xb] = x0 < x1 ? [x0, x1] : [x1, x0];
  const [ya, yb] = y0 < y1 ? [y0, y1] : [y1, y0];
  for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) paintPixel(buf, x, y, c);
}

/** Midpoint ellipse algorithm, hollow. */
function ellipseOn(buf: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number, c: RGBA) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
  if (rx < 0.5 && ry < 0.5) { paintPixel(buf, Math.round(cx), Math.round(cy), c); return; }
  // Sample many points along the perimeter; cheap and clean for low res
  const steps = Math.max(8, Math.ceil((rx + ry) * 4));
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const px = Math.round(cx + Math.cos(t) * rx);
    const py = Math.round(cy + Math.sin(t) * ry);
    paintPixel(buf, px, py, c);
  }
}

function fillEllipseOn(buf: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number, c: RGBA) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
  const [xa, xb] = x0 < x1 ? [x0, x1] : [x1, x0];
  const [ya, yb] = y0 < y1 ? [y0, y1] : [y1, y0];
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      if (rx < 0.5 || ry < 0.5) { paintPixel(buf, x, y, c); continue; }
      const nx = (x + 0.5 - cx) / rx;
      const ny = (y + 0.5 - cy) / ry;
      if (nx * nx + ny * ny <= 1) paintPixel(buf, x, y, c);
    }
  }
}

function floodOn(buf: Uint8ClampedArray, x: number, y: number, c: RGBA) {
  if (!inBounds(x, y)) return;
  const target = getPxRaw(buf, x, y);
  if (target.r === c.r && target.g === c.g && target.b === c.b && target.a === c.a) return;
  const stack: [number, number][] = [[x, y]];
  while (stack.length) {
    const [cx, cy] = stack.pop()!;
    if (!inBounds(cx, cy)) continue;
    const cur = getPxRaw(buf, cx, cy);
    if (cur.r !== target.r || cur.g !== target.g || cur.b !== target.b || cur.a !== target.a) continue;
    paintPixel(buf, cx, cy, c);
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
}

function pixelPerfectCorrect(buf: Uint8ClampedArray, trail: [number, number][], eraseTo: RGBA) {
  if (trail.length < 3) return;
  const [a, b, c] = trail.slice(-3);
  const abx = b[0] - a[0], aby = b[1] - a[1];
  const bcx = c[0] - b[0], bcy = c[1] - b[1];
  if (Math.abs(abx) + Math.abs(aby) === 1 && Math.abs(bcx) + Math.abs(bcy) === 1 && abx !== bcx && aby !== bcy) {
    paintPixel(buf, b[0], b[1], eraseTo);
  }
}

// ====================================================================
// Render
// ====================================================================
function applyServerSnapshot(snap: StateSnap) {
  const sizeChanged = state.width !== snap.width || state.height !== snap.height;
  state.width = snap.width;
  state.height = snap.height;
  const buf = atob(snap.data);
  const arr = new Uint8ClampedArray(buf.length);
  for (let i = 0; i < buf.length; i++) arr[i] = buf.charCodeAt(i);
  state.pixels = arr;
  if (Number(wInput.value) !== snap.width) wInput.value = String(snap.width);
  if (Number(hInput.value) !== snap.height) hInput.value = String(snap.height);
  statSize.textContent = `${state.width} × ${state.height}`;
  if (sizeChanged) {
    fitCanvas();
  }
  layoutCanvas();
  render();
}

function fitCanvas() {
  // Fit zoom so canvas fits comfortably in the area
  const rect = canvasArea.getBoundingClientRect();
  const padding = 60;
  const z = Math.max(1, Math.floor(Math.min((rect.width - padding) / state.width, (rect.height - padding) / state.height)));
  state.zoom = Math.min(32, z);
  // Center
  state.panX = (rect.width - state.width * state.zoom) / 2;
  state.panY = (rect.height - state.height * state.zoom) / 2;
}

function layoutCanvas() {
  canvasEl.width = state.width;
  canvasEl.height = state.height;
  overlayEl.width = state.width;
  overlayEl.height = state.height;
  const w = state.width * state.zoom;
  const h = state.height * state.zoom;
  canvasHost.style.width = w + "px";
  canvasHost.style.height = h + "px";
  canvasHost.style.transform = `translate(${state.panX}px, ${state.panY}px)`;
  canvasEl.style.width = w + "px";
  canvasEl.style.height = h + "px";
  overlayEl.style.width = w + "px";
  overlayEl.style.height = h + "px";
  statZoom.textContent = `${state.zoom * 100 / 1}%`;
}

function render() {
  const imgData = new ImageData(new Uint8ClampedArray(state.pixels), state.width, state.height);
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  ctx.putImageData(imgData, 0, 0);
  drawOverlay();
}

function drawOverlay() {
  octx.clearRect(0, 0, overlayEl.width, overlayEl.height);

  // Mirror axes (overlay is in canvas pixel units, but stroke widths look thin → scale-aware not needed since image-rendering pixelated)
  if (state.mirrorX) {
    octx.fillStyle = "rgba(255,80,80,0.6)";
    octx.fillRect(state.width / 2 - 0.05, 0, 0.1, state.height);
  }
  if (state.mirrorY) {
    octx.fillStyle = "rgba(255,80,80,0.6)";
    octx.fillRect(0, state.height / 2 - 0.05, state.width, 0.1);
  }

  // Grid: only when zoom is large enough; draw via CSS overlay alternative
  // We draw at canvas pixel resolution → grid lines would be too thin; do it in the overlay canvas via subpixel
  // For now: skip; grid done via separate technique below
}

/** Draw grid using a separate larger overlay technique: scale overlay canvas to display size for grid. */
function drawGridOverlay() {
  if (!state.grid || state.zoom < 4) {
    overlayEl.width = state.width;
    overlayEl.height = state.height;
    drawOverlay();
    return;
  }
  const w = state.width * state.zoom;
  const h = state.height * state.zoom;
  overlayEl.width = w;
  overlayEl.height = h;
  const c = overlayEl.getContext("2d")!;
  c.clearRect(0, 0, w, h);
  // Mirror axes scaled
  if (state.mirrorX) {
    c.fillStyle = "rgba(255,80,80,0.5)";
    c.fillRect(w / 2 - 1, 0, 2, h);
  }
  if (state.mirrorY) {
    c.fillStyle = "rgba(255,80,80,0.5)";
    c.fillRect(0, h / 2 - 1, w, 2);
  }
  c.strokeStyle = "rgba(255,255,255,0.15)";
  c.lineWidth = 1;
  c.beginPath();
  for (let x = 1; x < state.width; x++) {
    const px = x * state.zoom + 0.5;
    c.moveTo(px, 0); c.lineTo(px, h);
  }
  for (let y = 1; y < state.height; y++) {
    const py = y * state.zoom + 0.5;
    c.moveTo(0, py); c.lineTo(w, py);
  }
  c.stroke();
  // Selection
  if (state.selection) {
    const sel = normRect(state.selection);
    c.setLineDash([4, 4]);
    c.strokeStyle = "white";
    c.lineWidth = 1;
    c.strokeRect(sel.x0 * state.zoom + 0.5, sel.y0 * state.zoom + 0.5, (sel.x1 - sel.x0 + 1) * state.zoom - 1, (sel.y1 - sel.y0 + 1) * state.zoom - 1);
    c.setLineDash([]);
  }
}

function normRect(r: Rect): Rect {
  const [x0, x1] = r.x0 < r.x1 ? [r.x0, r.x1] : [r.x1, r.x0];
  const [y0, y1] = r.y0 < r.y1 ? [r.y0, r.y1] : [r.y1, r.y0];
  return { x0, y0, x1, y1 };
}

// ====================================================================
// History
// ====================================================================
function captureSnapshot(): { width: number; height: number; data: string } {
  let bin = "";
  for (let i = 0; i < state.pixels.length; i++) bin += String.fromCharCode(state.pixels[i]);
  return { width: state.width, height: state.height, data: btoa(bin) };
}
function pushHistory(prev: { width: number; height: number; data: string }) {
  state.undoStack.push(prev);
  if (state.undoStack.length > HISTORY_MAX) state.undoStack.shift();
  state.redoStack.length = 0;
  updateHistoryButtons();
}
function updateHistoryButtons() {
  undoBtn.disabled = state.undoStack.length === 0;
  redoBtn.disabled = state.redoStack.length === 0;
}
async function doUndo() {
  if (state.undoStack.length === 0) return;
  const cur = captureSnapshot();
  const prev = state.undoStack.pop()!;
  state.redoStack.push(cur);
  await api.applyOp("replace_data", prev);
  updateHistoryButtons();
}
async function doRedo() {
  if (state.redoStack.length === 0) return;
  const cur = captureSnapshot();
  const next = state.redoStack.pop()!;
  state.undoStack.push(cur);
  await api.applyOp("replace_data", next);
  updateHistoryButtons();
}
async function commitLocal() {
  await api.applyOp("replace_data", captureSnapshot());
}

// ====================================================================
// Color management
// ====================================================================
function setPrimary(c: RGBA, refreshPicker = true) {
  state.primary = c;
  primaryEl.style.setProperty("--c", rgbaToHex(c));
  if (refreshPicker) {
    const hsv = rgbToHsv(c.r, c.g, c.b);
    state.hsv = hsv;
    renderPicker();
  }
  rgbR.value = String(c.r);
  rgbG.value = String(c.g);
  rgbB.value = String(c.b);
  hexInput.value = rgbaToHex(c);
}
function setSecondary(c: RGBA) {
  state.secondary = c;
  secondaryEl.style.setProperty("--c", rgbaToHex(c));
}
function renderPicker() {
  const { h, s, v } = state.hsv;
  // SV pad background uses base hue
  (svPad.style as CSSStyleDeclaration & { background: string }).background =
    `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${h},100%,50%))`;
  svCursor.style.left = `${s * 100}%`;
  svCursor.style.top = `${(1 - v) * 100}%`;
  hueThumb.style.left = `${(h / 360) * 100}%`;
}
function setHSV(h: number, s: number, v: number) {
  state.hsv = { h, s, v };
  const rgb = hsvToRgb(h, s, v);
  setPrimary({ ...rgb, a: 255 }, false);
  renderPicker();
}

// ====================================================================
// Tools panel
// ====================================================================
function buildToolsPanel() {
  toolsPanel.innerHTML = "";
  TOOL_DEFS.forEach((t) => {
    const btn = document.createElement("button");
    btn.className = "tool-btn" + (t.id === state.tool ? " active" : "");
    btn.title = `${t.name} (${t.key})`;
    btn.dataset.tool = t.id;
    btn.innerHTML = `<svg viewBox="0 0 20 20">${ICONS[t.id]}</svg>`;
    btn.addEventListener("click", () => selectTool(t.id));
    toolsPanel.appendChild(btn);
  });
}
function selectTool(t: Tool) {
  state.tool = t;
  document.querySelectorAll<HTMLButtonElement>(".tool-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tool === t);
  });
  const def = TOOL_DEFS.find((d) => d.id === t);
  statTool.textContent = `ツール: ${def?.name ?? t}`;
  if (t !== "select") { state.selection = null; drawGridOverlay(); }
}

// ====================================================================
// Palette
// ====================================================================
function buildPalette() {
  paletteEl.innerHTML = "";
  DEFAULT_PALETTE.forEach((hex, i) => {
    const sw = document.createElement("div");
    sw.className = "swatch" + (i === state.paletteActive ? " active" : "");
    sw.style.background = hex;
    sw.title = hex;
    sw.addEventListener("click", () => {
      state.paletteActive = i;
      document.querySelectorAll(".palette-grid .swatch").forEach((x) => x.classList.remove("active"));
      sw.classList.add("active");
      setPrimary(hexToRGBA(hex));
    });
    sw.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      setSecondary(hexToRGBA(hex));
    });
    paletteEl.appendChild(sw);
  });
}

// ====================================================================
// Input: mouse / draw
// ====================================================================
function screenToPixel(clientX: number, clientY: number): [number, number] {
  const rect = canvasEl.getBoundingClientRect();
  const x = Math.floor((clientX - rect.left) / state.zoom);
  const y = Math.floor((clientY - rect.top) / state.zoom);
  return [x, y];
}

function currentColor(): RGBA {
  return state.rmbDown ? state.secondary : state.primary;
}

canvasArea.addEventListener("mousedown", (e) => {
  // Panning
  if (e.button === 1 || (e.button === 0 && state.spaceHeld)) {
    e.preventDefault();
    state.panning = true;
    canvasArea.classList.add("active");
    state.panStart = [e.clientX - state.panX, e.clientY - state.panY];
    return;
  }
  if (e.button !== 0 && e.button !== 2) return;
  if (e.button === 2) state.rmbDown = true;

  const [x, y] = screenToPixel(e.clientX, e.clientY);

  // Picker is one-shot
  if (state.tool === "picker" || (e.altKey)) {
    if (inBounds(x, y)) {
      const p = getPxRaw(state.pixels, x, y);
      if (p.a > 0) {
        if (e.button === 2 || state.rmbDown) setSecondary(p);
        else setPrimary(p);
      }
    }
    return;
  }

  state.drawing = true;
  state.startX = x; state.startY = y;
  state.lastX = x; state.lastY = y;
  state.preDragSnapshot = new Uint8ClampedArray(state.pixels);
  state.penTrail = [[x, y]];

  const isEraser = state.tool === "eraser";
  const c = isEraser ? ERASE : currentColor();

  if (state.tool === "pen" || state.tool === "eraser") {
    paintBrush(state.pixels, x, y, c);
    render();
  } else if (state.tool === "bucket") {
    floodOn(state.pixels, x, y, c);
    render();
  } else if (state.tool === "select") {
    state.selection = { x0: x, y0: y, x1: x, y1: y };
    drawGridOverlay();
  }
});

window.addEventListener("mousemove", (e) => {
  if (state.panning) {
    state.panX = e.clientX - state.panStart[0];
    state.panY = e.clientY - state.panStart[1];
    canvasHost.style.transform = `translate(${state.panX}px, ${state.panY}px)`;
    return;
  }
  const [x, y] = screenToPixel(e.clientX, e.clientY);
  if (inBounds(x, y)) {
    statPos.textContent = `x: ${x}, y: ${y}`;
    const p = getPxRaw(state.pixels, x, y);
    if (p.a > 0) {
      const hex = rgbaToHex(p);
      statColorHex.textContent = hex;
      (statColorChip as HTMLElement).style.background = hex;
    } else {
      statColorHex.textContent = "—";
      (statColorChip as HTMLElement).style.background = "transparent";
    }
  }
  if (!state.drawing) return;
  const isEraser = state.tool === "eraser";
  const c = isEraser ? ERASE : currentColor();

  if (state.tool === "pen" || state.tool === "eraser") {
    lineOn(state.pixels, state.lastX, state.lastY, x, y, c, true);
    if (x !== state.lastX || y !== state.lastY) {
      state.penTrail.push([x, y]);
      if (state.pixelPerfect && state.tool === "pen" && state.brushSize === 1) {
        pixelPerfectCorrect(state.pixels, state.penTrail, ERASE);
      }
    }
    state.lastX = x; state.lastY = y;
    render();
  } else if (
    state.tool === "line" || state.tool === "rect" || state.tool === "fillRect" ||
    state.tool === "ellipse" || state.tool === "fillEllipse"
  ) {
    state.pixels.set(state.preDragSnapshot!);
    if (state.tool === "line") lineOn(state.pixels, state.startX, state.startY, x, y, c, true);
    if (state.tool === "rect") rectOn(state.pixels, state.startX, state.startY, x, y, c);
    if (state.tool === "fillRect") fillRectOn(state.pixels, state.startX, state.startY, x, y, c);
    if (state.tool === "ellipse") ellipseOn(state.pixels, state.startX, state.startY, x, y, c);
    if (state.tool === "fillEllipse") fillEllipseOn(state.pixels, state.startX, state.startY, x, y, c);
    render();
  } else if (state.tool === "select") {
    state.selection = { x0: state.startX, y0: state.startY, x1: x, y1: y };
    drawGridOverlay();
  }
});

window.addEventListener("mouseup", async (e) => {
  if (state.panning) {
    state.panning = false;
    canvasArea.classList.remove("active");
    return;
  }
  if (e.button === 2) state.rmbDown = false;
  if (!state.drawing) return;
  state.drawing = false;
  if (state.tool !== "select") {
    if (state.preDragSnapshot) {
      let bin = "";
      for (let i = 0; i < state.preDragSnapshot.length; i++) bin += String.fromCharCode(state.preDragSnapshot[i]);
      pushHistory({ width: state.width, height: state.height, data: btoa(bin) });
      await commitLocal();
    }
  } else if (state.selection) {
    state.selection = normRect(state.selection);
    drawGridOverlay();
  }
  state.preDragSnapshot = null;
  state.penTrail = [];
});

canvasArea.addEventListener("contextmenu", (e) => e.preventDefault());

// ====================================================================
// Zoom (wheel)
// ====================================================================
canvasArea.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = canvasArea.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  // World coords under cursor
  const wx = (mx - state.panX) / state.zoom;
  const wy = (my - state.panY) / state.zoom;
  const oldZoom = state.zoom;
  if (e.deltaY < 0) state.zoom = Math.min(48, state.zoom + 1);
  else state.zoom = Math.max(1, state.zoom - 1);
  if (state.zoom === oldZoom) return;
  // Keep cursor point fixed
  state.panX = mx - wx * state.zoom;
  state.panY = my - wy * state.zoom;
  layoutCanvas();
  drawGridOverlay();
}, { passive: false });

// ====================================================================
// Toolbar controls
// ====================================================================
undoBtn.addEventListener("click", doUndo);
redoBtn.addEventListener("click", doRedo);
gridBtn.addEventListener("click", () => {
  state.grid = !state.grid;
  gridBtn.classList.toggle("active", state.grid);
  drawGridOverlay();
});
ppBtn.addEventListener("click", () => {
  state.pixelPerfect = !state.pixelPerfect;
  ppBtn.classList.toggle("active", state.pixelPerfect);
});
mxBtn.addEventListener("click", () => {
  state.mirrorX = !state.mirrorX;
  mxBtn.classList.toggle("active", state.mirrorX);
  drawGridOverlay();
});
myBtn.addEventListener("click", () => {
  state.mirrorY = !state.mirrorY;
  myBtn.classList.toggle("active", state.mirrorY);
  drawGridOverlay();
});
ppBtn.classList.toggle("active", state.pixelPerfect);

// Brush size buttons
document.querySelectorAll<HTMLButtonElement>('[data-brush]').forEach((b) => {
  if (Number(b.dataset.brush) === state.brushSize) b.classList.add("active");
  b.addEventListener("click", () => {
    state.brushSize = Number(b.dataset.brush) || 1;
    document.querySelectorAll('[data-brush]').forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
  });
});

newBtn.addEventListener("click", async () => {
  const w = Math.max(1, Math.min(128, parseInt(wInput.value, 10) || 32));
  const h = Math.max(1, Math.min(128, parseInt(hInput.value, 10) || 32));
  pushHistory(captureSnapshot());
  await api.applyOp("new_canvas", { width: w, height: h });
});

swapBtn.addEventListener("click", () => {
  const tmp = state.primary;
  setPrimary(state.secondary);
  setSecondary(tmp);
});
primaryEl.addEventListener("click", () => { /* visual only */ });
secondaryEl.addEventListener("click", () => {
  const tmp = state.primary;
  setPrimary(state.secondary);
  setSecondary(tmp);
});

// ====================================================================
// Color picker interaction
// ====================================================================
let svDragging = false, hueDragging = false;
function svPick(e: MouseEvent) {
  const r = svPad.getBoundingClientRect();
  const s = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  const v = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
  setHSV(state.hsv.h, s, v);
}
function huePick(e: MouseEvent) {
  const r = hueSlider.getBoundingClientRect();
  const h = Math.max(0, Math.min(360, ((e.clientX - r.left) / r.width) * 360));
  setHSV(h, state.hsv.s, state.hsv.v);
}
svPad.addEventListener("mousedown", (e) => { svDragging = true; svPick(e); });
hueSlider.addEventListener("mousedown", (e) => { hueDragging = true; huePick(e); });
window.addEventListener("mousemove", (e) => {
  if (svDragging) svPick(e);
  if (hueDragging) huePick(e);
});
window.addEventListener("mouseup", () => { svDragging = false; hueDragging = false; });

[rgbR, rgbG, rgbB].forEach((el) => {
  el.addEventListener("change", () => {
    const c: RGBA = { r: clamp255(rgbR.value), g: clamp255(rgbG.value), b: clamp255(rgbB.value), a: 255 };
    setPrimary(c);
  });
});
hexInput.addEventListener("change", () => {
  if (/^#?[0-9a-fA-F]{6}$/.test(hexInput.value) || /^#?[0-9a-fA-F]{3}$/.test(hexInput.value)) {
    setPrimary(hexToRGBA(hexInput.value));
  }
});
function clamp255(s: string) { const n = parseInt(s, 10); return Math.max(0, Math.min(255, Number.isFinite(n) ? n : 0)); }

// ====================================================================
// Selection clipboard
// ====================================================================
function copySelection(cut: boolean) {
  if (!state.selection) return;
  const sel = normRect(state.selection);
  const w = sel.x1 - sel.x0 + 1, h = sel.y1 - sel.y0 + 1;
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = ((sel.y0 + y) * state.width + (sel.x0 + x)) * 4;
    const di = (y * w + x) * 4;
    buf[di] = state.pixels[si]; buf[di + 1] = state.pixels[si + 1];
    buf[di + 2] = state.pixels[si + 2]; buf[di + 3] = state.pixels[si + 3];
  }
  state.clipboard = { width: w, height: h, pixels: buf };
  if (cut) {
    pushHistory(captureSnapshot());
    for (let y = sel.y0; y <= sel.y1; y++) for (let x = sel.x0; x <= sel.x1; x++) {
      const i = (y * state.width + x) * 4;
      state.pixels[i] = 0; state.pixels[i + 1] = 0; state.pixels[i + 2] = 0; state.pixels[i + 3] = 0;
    }
    commitLocal();
  }
}
function pasteClipboard() {
  if (!state.clipboard) return;
  const dx = state.selection ? normRect(state.selection).x0 : 0;
  const dy = state.selection ? normRect(state.selection).y0 : 0;
  pushHistory(captureSnapshot());
  const { width: w, height: h, pixels } = state.clipboard;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = (y * w + x) * 4;
    if (pixels[si + 3] === 0) continue;
    const tx = dx + x, ty = dy + y;
    if (!inBounds(tx, ty)) continue;
    const di = (ty * state.width + tx) * 4;
    state.pixels[di] = pixels[si]; state.pixels[di + 1] = pixels[si + 1];
    state.pixels[di + 2] = pixels[si + 2]; state.pixels[di + 3] = pixels[si + 3];
  }
  state.selection = { x0: dx, y0: dy, x1: dx + w - 1, y1: dy + h - 1 };
  render(); drawGridOverlay(); commitLocal();
}
function deleteSelection() {
  if (!state.selection) return;
  const sel = normRect(state.selection);
  pushHistory(captureSnapshot());
  for (let y = sel.y0; y <= sel.y1; y++) for (let x = sel.x0; x <= sel.x1; x++) {
    const i = (y * state.width + x) * 4;
    state.pixels[i] = 0; state.pixels[i + 1] = 0; state.pixels[i + 2] = 0; state.pixels[i + 3] = 0;
  }
  render(); commitLocal();
}
function selectAll() {
  state.selection = { x0: 0, y0: 0, x1: state.width - 1, y1: state.height - 1 };
  selectTool("select");
  drawGridOverlay();
}

// ====================================================================
// Keyboard
// ====================================================================
const KEY_TO_TOOL: Record<string, Tool> = {
  b: "pen", e: "eraser", l: "line",
  u: "rect", o: "ellipse", g: "bucket",
  i: "picker", m: "select", v: "move",
};
window.addEventListener("keydown", (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (e.target instanceof HTMLInputElement) return;

  // Pan
  if (e.code === "Space" && !state.spaceHeld) {
    state.spaceHeld = true;
    canvasArea.classList.add("panning");
    e.preventDefault();
    return;
  }

  if (meta && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); doUndo(); return; }
  if (meta && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); doRedo(); return; }
  if (meta && e.key.toLowerCase() === "g") { e.preventDefault(); gridBtn.click(); return; }
  if (meta && e.key.toLowerCase() === "a") { e.preventDefault(); selectAll(); return; }
  if (meta && e.key.toLowerCase() === "c") { e.preventDefault(); copySelection(false); return; }
  if (meta && e.key.toLowerCase() === "x") { e.preventDefault(); copySelection(true); return; }
  if (meta && e.key.toLowerCase() === "v") { e.preventDefault(); pasteClipboard(); return; }
  if (e.key === "Delete" || e.key === "Backspace") { if (state.selection) { e.preventDefault(); deleteSelection(); } return; }
  if (e.key === "Escape") { state.selection = null; drawGridOverlay(); return; }
  if (e.key === "x" || e.key === "X") { swapBtn.click(); return; }
  if (e.key === "h" || e.key === "H") { mxBtn.click(); return; }
  if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomAt(1); return; }
  if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomAt(-1); return; }
  if (e.key === "0") { fitCanvas(); layoutCanvas(); drawGridOverlay(); return; }
  if (e.key === "[") { state.brushSize = Math.max(1, state.brushSize - 1); refreshBrushUI(); return; }
  if (e.key === "]") { state.brushSize = Math.min(8, state.brushSize + 1); refreshBrushUI(); return; }

  // Tool keys
  const k = e.key.toLowerCase();
  if (KEY_TO_TOOL[k]) {
    if (e.shiftKey && k === "u") selectTool("fillRect");
    else if (e.shiftKey && k === "o") selectTool("fillEllipse");
    else selectTool(KEY_TO_TOOL[k]);
  }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space") {
    state.spaceHeld = false;
    canvasArea.classList.remove("panning");
  }
});
function zoomAt(direction: number) {
  const rect = canvasArea.getBoundingClientRect();
  const mx = rect.width / 2, my = rect.height / 2;
  const wx = (mx - state.panX) / state.zoom, wy = (my - state.panY) / state.zoom;
  state.zoom = Math.max(1, Math.min(48, state.zoom + direction));
  state.panX = mx - wx * state.zoom;
  state.panY = my - wy * state.zoom;
  layoutCanvas();
  drawGridOverlay();
}
function refreshBrushUI() {
  document.querySelectorAll<HTMLButtonElement>('[data-brush]').forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.brush) === state.brushSize);
  });
}

// ====================================================================
// Window resize
// ====================================================================
window.addEventListener("resize", () => {
  layoutCanvas();
  drawGridOverlay();
});

// ====================================================================
// Init
// ====================================================================
api.onState((snap) => {
  if (state.drawing) return;
  applyServerSnapshot(snap);
  modeEl.classList.add("remote");
  modeEl.classList.remove("standalone");
  modeEl.textContent = "● 同期中";
});

(async () => {
  buildToolsPanel();
  buildPalette();
  const snap = await api.getState();
  applyServerSnapshot(snap);
  setPrimary(state.primary);
  setSecondary(state.secondary);
  updateHistoryButtons();
  drawGridOverlay();
  modeEl.classList.add("remote");
  modeEl.textContent = "● 同期中";
})();
