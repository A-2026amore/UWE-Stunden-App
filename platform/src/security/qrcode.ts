/**
 * Minimal QR code encoder (ISO/IEC 18004, model 2) for the 2FA setup –
 * no dependencies. Byte mode only, all 40 versions, error correction L/M/Q/H,
 * automatic mask selection. Structure follows the well-known reference
 * algorithm (finder/timing/alignment patterns, Reed–Solomon over GF(256),
 * block interleaving, format and version information).
 *
 * Result: a square boolean matrix (true = dark module), without quiet zone.
 */

export type QrEcc = "L" | "M" | "Q" | "H";

const ECC_FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };

// Index = version (1–40); index 0 unused.
const ECC_CODEWORDS_PER_BLOCK: Record<QrEcc, number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
const NUM_ERROR_CORRECTION_BLOCKS: Record<QrEcc, number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

export interface QrCode {
  version: number;
  size: number;
  ecc: QrEcc;
  mask: number;
  /** modules[y][x], true = dark. */
  modules: boolean[][];
}

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

/** Raw data modules of a version (all modules minus function patterns, format/version info). */
export function numRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

export function numDataCodewords(ver: number, ecc: QrEcc): number {
  return Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[ecc][ver]! * NUM_ERROR_CORRECTION_BLOCKS[ecc][ver]!;
}

export function alignmentPatternPositions(ver: number): number[] {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = ver * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

// ------------------------------------------------------------------ Reed–Solomon over GF(2^8), polynomial 0x11D

export function rsMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

export function rsDivisor(degree: number): number[] {
  const result: number[] = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = rsMultiply(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = rsMultiply(root, 0x02);
  }
  return result;
}

export function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result: number[] = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => { result[i]! ^= rsMultiply(coef, factor); });
  }
  return result;
}

// ------------------------------------------------------------------ data encoding (byte mode)

function charCountBits(ver: number): number {
  return ver <= 9 ? 8 : 16;
}

/** Data codewords incl. mode, length, terminator and padding. */
function encodeData(bytes: Uint8Array, ver: number, ecc: QrEcc): number[] {
  const bits: number[] = [];
  const push = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, charCountBits(ver));
  for (const b of bytes) push(b, 8);
  const capacity = numDataCodewords(ver, ecc) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  return out;
}

/** Splits into blocks, appends the ECC of each block and interleaves. */
export function addEccAndInterleave(data: readonly number[], ver: number, ecc: QrEcc): number[] {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecc][ver]!;
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecc][ver]!;
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const eccBytes = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(eccBytes));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]!);
    });
  }
  return result;
}

// ------------------------------------------------------------------ matrix

class Matrix {
  readonly size: number;
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];
  readonly version: number;
  constructor(version: number) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }
  setFunction(x: number, y: number, dark: boolean) {
    this.modules[y]![x] = dark;
    this.isFunction[y]![x] = true;
  }
}

function drawFunctionPatterns(m: Matrix, ecc: QrEcc): void {
  for (let i = 0; i < m.size; i++) {
    m.setFunction(6, i, i % 2 === 0);
    m.setFunction(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && x < m.size && y >= 0 && y < m.size) m.setFunction(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(m.size - 4, 3);
  finder(3, m.size - 4);
  const pos = alignmentPatternPositions(m.version);
  const n = pos.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) m.setFunction(pos[i]! + dx, pos[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }
  drawFormatBits(m, ecc, 0); // reserves the area; overwritten after masking
  drawVersion(m);
}

export function formatBits(ecc: QrEcc, mask: number): number {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function drawFormatBits(m: Matrix, ecc: QrEcc, mask: number): void {
  const bits = formatBits(ecc, mask);
  for (let i = 0; i <= 5; i++) m.setFunction(8, i, bit(bits, i));
  m.setFunction(8, 7, bit(bits, 6));
  m.setFunction(8, 8, bit(bits, 7));
  m.setFunction(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) m.setFunction(14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i++) m.setFunction(m.size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) m.setFunction(8, m.size - 15 + i, bit(bits, i));
  m.setFunction(8, m.size - 8, true); // dark module
}

function drawVersion(m: Matrix): void {
  if (m.version < 7) return;
  let rem = m.version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (m.version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = bit(bits, i);
    const a = m.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    m.setFunction(a, b, dark);
    m.setFunction(b, a, dark);
  }
}

/** Visits the data modules in placement order (two-column zig-zag from the bottom right). */
export function forEachDataModule(size: number, isFunction: boolean[][], fn: (x: number, y: number) => void): void {
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y]![x]) fn(x, y);
      }
    }
  }
}

function drawCodewords(m: Matrix, data: readonly number[]): void {
  let i = 0;
  forEachDataModule(m.size, m.isFunction, (x, y) => {
    if (i < data.length * 8) m.modules[y]![x] = bit(data[i >>> 3]!, 7 - (i & 7));
    i++; // remainder bits stay light
  });
}

export function maskApplies(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new Error("Ungültige Maske.");
  }
}

function applyMask(m: Matrix, mask: number): void {
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.isFunction[y]![x] && maskApplies(mask, x, y)) m.modules[y]![x] = !m.modules[y]![x];
    }
  }
}

/** Penalty score (ISO 18004, 8.8.2): runs, 2×2 blocks, finder-like patterns, dark/light balance. */
export function penaltyScore(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let y = 0; y < size; y++) lines.push(modules[y]!);
  for (let x = 0; x < size; x++) lines.push(modules.map((row) => row[x]!));
  const pattern1 = [true, false, true, true, true, false, true, false, false, false, false];
  const pattern2 = [false, false, false, false, true, false, true, true, true, false, true];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= line.length; i++) {
      if (i < line.length && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    for (let i = 0; i + 11 <= line.length; i++) {
      if (pattern1.every((v, k) => line[i + k] === v) || pattern2.every((v, k) => line[i + k] === v)) score += 40;
    }
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y]![x];
      if (c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1]) score += 3;
    }
  }
  let dark = 0;
  for (const row of modules) for (const v of row) if (v) dark++;
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  score += Math.max(0, k) * 10;
  return score;
}

/** Encodes bytes or text (UTF-8) with the smallest fitting version. */
export function encodeQr(input: string | Uint8Array, ecc: QrEcc = "M"): QrCode {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let version = 0;
  for (let v = 1; v <= 40; v++) {
    const needed = 4 + charCountBits(v) + bytes.length * 8;
    if (needed <= numDataCodewords(v, ecc) * 8) { version = v; break; }
  }
  if (!version) throw new Error("Zu viele Daten für einen QR-Code.");
  const codewords = addEccAndInterleave(encodeData(bytes, version, ecc), version, ecc);

  let best: Matrix | null = null;
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = new Matrix(version);
    drawFunctionPatterns(m, ecc);
    drawCodewords(m, codewords);
    applyMask(m, mask);
    drawFormatBits(m, ecc, mask);
    const s = penaltyScore(m.modules);
    if (s < bestScore) { best = m; bestMask = mask; bestScore = s; }
  }
  return { version, size: best!.size, ecc, mask: bestMask, modules: best!.modules };
}

/** Function-pattern map of a version (used by tests to read the data back). */
export function functionModules(version: number, ecc: QrEcc = "M"): boolean[][] {
  const m = new Matrix(version);
  drawFunctionPatterns(m, ecc);
  return m.isFunction;
}

/** SVG path ("M x y h1 v1 h-1 z" per dark module, offset by the quiet zone). */
export function qrSvgPath(code: QrCode, quietZone = 4): string {
  const parts: string[] = [];
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (code.modules[y]![x]) parts.push(`M${x + quietZone} ${y + quietZone}h1v1h-1z`);
    }
  }
  return parts.join("");
}
