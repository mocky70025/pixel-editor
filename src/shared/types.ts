export type RGBA = { r: number; g: number; b: number; a: number };

export interface CanvasSnapshot {
  width: number;
  height: number;
  /** RGBA bytes, length = width * height * 4 */
  data: Uint8ClampedArray;
}

export const MAX_DIM = 128;

export function hexToRgba(hex: string, alpha = 255): RGBA {
  const s = hex.replace(/^#/, "");
  const v = s.length === 3
    ? s.split("").map((c) => c + c).join("")
    : s;
  const n = parseInt(v, 16);
  return {
    r: (n >> 16) & 0xff,
    g: (n >> 8) & 0xff,
    b: n & 0xff,
    a: alpha,
  };
}

export function rgbaToHex({ r, g, b }: RGBA): string {
  const h = (v: number) => v.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
