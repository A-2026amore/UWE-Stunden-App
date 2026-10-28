import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  alignmentPatternPositions, encodeQr, forEachDataModule, formatBits, functionModules, maskApplies, numDataCodewords,
  numRawDataModules, qrSvgPath, rsDivisor, rsRemainder, type QrCode, type QrEcc,
} from "./qrcode";

const BLOCKS: Record<QrEcc, Record<number, [number, number]>> = {
  // version → [number of blocks, ECC codewords per block] (ISO 18004, table 9) for the versions read back below
  L: { 1: [1, 7], 2: [1, 10], 7: [2, 20], 10: [4, 18] },
  M: { 1: [1, 10], 5: [2, 24], 7: [4, 18], 8: [4, 22], 10: [5, 26] },
  Q: { 1: [1, 13], 5: [4, 18], 7: [6, 18] },
  H: { 1: [1, 17], 5: [4, 22], 7: [5, 26] },
};

/** Reads the payload back from the matrix (unmask, de-interleave, check Reed–Solomon, parse byte mode). */
function decode(code: QrCode): string {
  const isFunction = functionModules(code.version, code.ecc);
  const bits: number[] = [];
  forEachDataModule(code.size, isFunction, (x, y) => bits.push(code.modules[y]![x]! !== maskApplies(code.mask, x, y) ? 1 : 0));
  const raw = Math.floor(numRawDataModules(code.version) / 8);
  const codewords: number[] = [];
  for (let i = 0; i < raw; i++) codewords.push(bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | b, 0));
  const [numBlocks, eccLen] = BLOCKS[code.ecc][code.version]!;
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const blocks: number[][] = Array.from({ length: numBlocks }, () => []);
  let k = 0;
  for (let i = 0; i < shortLen + 1; i++) {
    for (let j = 0; j < numBlocks; j++) {
      if (i === shortLen - eccLen && j < numShort) continue;
      blocks[j]!.push(codewords[k++]!);
    }
  }
  const data: number[] = [];
  const divisor = rsDivisor(eccLen);
  for (const b of blocks) {
    const dat = b.slice(0, b.length - eccLen);
    expect(rsRemainder(dat, divisor)).toEqual(b.slice(b.length - eccLen));
    data.push(...dat);
  }
  expect(data.length).toBe(numDataCodewords(code.version, code.ecc));
  const dbits = data.flatMap((b) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (b >>> i) & 1));
  const read = (from: number, len: number) => dbits.slice(from, from + len).reduce((a, b) => (a << 1) | b, 0);
  expect(read(0, 4)).toBe(0b0100);
  const lenBits = code.version <= 9 ? 8 : 16;
  const n = read(4, lenBits);
  const bytes = Uint8Array.from({ length: n }, (_, i) => read(4 + lenBits + i * 8, 8));
  return new TextDecoder().decode(bytes);
}

function readFormat(code: QrCode): number {
  const m = code.modules;
  let v = 0;
  // First copy: (8,0..5), (8,7), (8,8), (7,8), (5..0,8) → bits 0..14
  const coords: Array<[number, number]> = [];
  for (let i = 0; i <= 5; i++) coords.push([8, i]);
  coords.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) coords.push([14 - i, 8]);
  coords.forEach(([x, y], i) => { if (m[y]![x]) v |= 1 << i; });
  return v;
}

describe("QR code encoder", () => {
  it("chooses the smallest version and draws finder, timing and dark module", () => {
    const q = encodeQr("HELLO");
    expect(q.version).toBe(1);
    expect(q.size).toBe(21);
    const finderRow = [true, true, true, true, true, true, true];
    expect(q.modules[0]!.slice(0, 7)).toEqual(finderRow);
    expect(q.modules[0]!.slice(14, 21)).toEqual(finderRow);
    expect(q.modules[20]!.slice(0, 7)).toEqual(finderRow);
    expect(q.modules[3]!.slice(0, 7)).toEqual([true, false, true, true, true, false, true]);
    for (let i = 8; i < 13; i++) expect(q.modules[6]![i]).toBe(i % 2 === 0);
    expect(q.modules[q.size - 8]![8]).toBe(true);
  });

  it("writes format information with the chosen mask and error correction level", () => {
    for (const ecc of ["L", "M", "Q", "H"] as const) {
      const q = encodeQr("otpauth://totp/Stundenwerk:a%40b.example?secret=ABCD", ecc);
      expect(readFormat(q)).toBe(formatBits(ecc, q.mask));
    }
    // Known value from ISO 18004 annex C: level M, mask 5 → 100000011001110
    expect(formatBits("M", 5).toString(2).padStart(15, "0")).toBe("100000011001110");
  });

  it("computes the alignment positions of ISO 18004 annex E", () => {
    expect(alignmentPatternPositions(1)).toEqual([]);
    expect(alignmentPatternPositions(2)).toEqual([6, 18]);
    expect(alignmentPatternPositions(7)).toEqual([6, 22, 38]);
    expect(alignmentPatternPositions(32)).toEqual([6, 34, 60, 86, 112, 138]);
    expect(alignmentPatternPositions(40)).toEqual([6, 30, 58, 86, 114, 142, 170]);
    expect(numDataCodewords(1, "M")).toBe(16);
    expect(numDataCodewords(7, "M")).toBe(124);
    expect(numDataCodewords(10, "M")).toBe(216);
  });

  it.each([
    ["HELLO", "M"], ["otpauth://totp/Stundenwerk:superadmin%40plattform.example?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Stundenwerk&algorithm=SHA1&digits=6&period=30", "M"],
    ["Zwei-Faktor-Anmeldung äöü ß", "L"], ["x".repeat(60), "Q"], ["y".repeat(40), "H"], ["z".repeat(200), "M"], ["v".repeat(250), "L"],
  ] as Array<[string, QrEcc]>)("round-trips %s (%s) incl. Reed–Solomon check", (text, ecc) => {
    const q = encodeQr(text, ecc);
    expect(BLOCKS[ecc][q.version], `version ${q.version} not in the test table`).toBeDefined();
    expect(decode(q)).toBe(text);
  });

  it("produces the reference matrix verified with an independent decoder (OpenCV)", () => {
    const t = "otpauth://totp/Stundenwerk:test%40example.org?secret=JBSWY3DPEHPK3PXP&issuer=Stundenwerk&algorithm=SHA1&digits=6&period=30";
    const q = encodeQr(t);
    const s = q.modules.map((r) => r.map((b) => (b ? "1" : "0")).join("")).join("\n");
    expect([q.version, q.mask]).toEqual([7, 4]);
    expect(createHash("sha256").update(s).digest("hex")).toBe("734d18eb5cb9ec120b2790573f0fb69de9eec5663953e77d64fc95d47b6c9ce8");
  });

  it("rejects too much data and renders an SVG path with quiet zone", () => {
    expect(() => encodeQr("x".repeat(3000))).toThrow("Zu viele Daten");
    const q = encodeQr("A");
    const path = qrSvgPath(q);
    expect(path.startsWith("M4 4h1v1h-1z")).toBe(true);
    const dark = q.modules.flat().filter(Boolean).length;
    expect(path.split("z").length - 1).toBe(dark);
  });
});
