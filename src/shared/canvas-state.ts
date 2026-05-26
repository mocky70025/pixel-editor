import { PNG } from "pngjs";
import * as fs from "fs";
import { CanvasSnapshot, MAX_DIM, RGBA } from "./types";

export class CanvasState {
  width: number;
  height: number;
  data: Uint8ClampedArray;

  constructor(width = 32, height = 32) {
    this.width = clampDim(width);
    this.height = clampDim(height);
    this.data = new Uint8ClampedArray(this.width * this.height * 4);
  }

  reset(width: number, height: number): void {
    this.width = clampDim(width);
    this.height = clampDim(height);
    this.data = new Uint8ClampedArray(this.width * this.height * 4);
  }

  snapshot(): CanvasSnapshot {
    return {
      width: this.width,
      height: this.height,
      data: new Uint8ClampedArray(this.data),
    };
  }

  loadSnapshot(snap: CanvasSnapshot): void {
    this.width = snap.width;
    this.height = snap.height;
    this.data = new Uint8ClampedArray(snap.data);
  }

  private idx(x: number, y: number): number {
    return (y * this.width + x) * 4;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  setPixel(x: number, y: number, c: RGBA): void {
    if (!this.inBounds(x, y)) return;
    const i = this.idx(x, y);
    this.data[i] = c.r;
    this.data[i + 1] = c.g;
    this.data[i + 2] = c.b;
    this.data[i + 3] = c.a;
  }

  getPixel(x: number, y: number): RGBA | null {
    if (!this.inBounds(x, y)) return null;
    const i = this.idx(x, y);
    return { r: this.data[i], g: this.data[i + 1], b: this.data[i + 2], a: this.data[i + 3] };
  }

  clear(): void {
    this.data.fill(0);
  }

  drawLine(x0: number, y0: number, x1: number, y1: number, c: RGBA): void {
    // Bresenham
    let dx = Math.abs(x1 - x0);
    let dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let x = x0, y = y0;
    while (true) {
      this.setPixel(x, y, c);
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
  }

  drawRect(x0: number, y0: number, x1: number, y1: number, c: RGBA): void {
    this.drawLine(x0, y0, x1, y0, c);
    this.drawLine(x1, y0, x1, y1, c);
    this.drawLine(x1, y1, x0, y1, c);
    this.drawLine(x0, y1, x0, y0, c);
  }

  fillRect(x0: number, y0: number, x1: number, y1: number, c: RGBA): void {
    const [xa, xb] = x0 < x1 ? [x0, x1] : [x1, x0];
    const [ya, yb] = y0 < y1 ? [y0, y1] : [y1, y0];
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        this.setPixel(x, y, c);
      }
    }
  }

  floodFill(x: number, y: number, c: RGBA): void {
    if (!this.inBounds(x, y)) return;
    const target = this.getPixel(x, y)!;
    if (sameColor(target, c)) return;
    const stack: [number, number][] = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop()!;
      if (!this.inBounds(cx, cy)) continue;
      const cur = this.getPixel(cx, cy)!;
      if (!sameColor(cur, target)) continue;
      this.setPixel(cx, cy, c);
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
  }

  toPNGBuffer(): Buffer {
    const png = new PNG({ width: this.width, height: this.height });
    png.data = Buffer.from(this.data.buffer, this.data.byteOffset, this.data.byteLength);
    return PNG.sync.write(png);
  }

  toPNGBufferScaled(scale: number): Buffer {
    const s = Math.max(1, Math.floor(scale));
    if (s === 1) return this.toPNGBuffer();
    const w = this.width * s;
    const h = this.height * s;
    const png = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = Math.floor(x / s);
        const sy = Math.floor(y / s);
        const srcI = (sy * this.width + sx) * 4;
        const dstI = (y * w + x) * 4;
        png.data[dstI] = this.data[srcI];
        png.data[dstI + 1] = this.data[srcI + 1];
        png.data[dstI + 2] = this.data[srcI + 2];
        png.data[dstI + 3] = this.data[srcI + 3];
      }
    }
    return PNG.sync.write(png);
  }

  savePNG(path: string, scale = 1): void {
    fs.writeFileSync(path, this.toPNGBufferScaled(scale));
  }

  loadPNG(path: string): void {
    const buf = fs.readFileSync(path);
    const png = PNG.sync.read(buf);
    if (png.width > MAX_DIM || png.height > MAX_DIM) {
      throw new Error(`PNG too large: ${png.width}x${png.height} (max ${MAX_DIM}x${MAX_DIM})`);
    }
    this.width = png.width;
    this.height = png.height;
    this.data = new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength).slice();
  }

  /** Quantize an external RGBA image into this canvas, downsampling. */
  loadFromImageRGBA(rgba: Uint8ClampedArray, srcW: number, srcH: number, targetW: number, targetH: number): void {
    this.reset(targetW, targetH);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const sx = Math.floor(x * srcW / this.width);
        const sy = Math.floor(y * srcH / this.height);
        const si = (sy * srcW + sx) * 4;
        const di = (y * this.width + x) * 4;
        this.data[di] = rgba[si];
        this.data[di + 1] = rgba[si + 1];
        this.data[di + 2] = rgba[si + 2];
        this.data[di + 3] = rgba[si + 3];
      }
    }
  }
}

function sameColor(a: RGBA, b: RGBA): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;
}

function clampDim(v: number): number {
  const n = Math.floor(v);
  if (!Number.isFinite(n) || n < 1) return 1;
  if (n > MAX_DIM) return MAX_DIM;
  return n;
}
