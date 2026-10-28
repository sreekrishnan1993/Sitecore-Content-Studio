import { inflateRawSync } from "node:zlib";

// ZIP inspection for DOCX uploads, done before any parser sees the file.
//
// Declared sizes in a ZIP are attacker-controlled, so they are only used for a quick
// pre-check. `verifyZipExpansion` then really decompresses every entry with a hard output
// cap, which defeats decompression bombs whose headers lie about their size.

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  declaredSize: number;
  localHeaderOffset: number;
}

export interface ZipEntrySummary {
  names: string[];
  entries: ZipEntry[];
  totalUncompressed: number;
}

const MAX_ENTRIES = 5000;

export function scanZip(bytes: Uint8Array): ZipEntrySummary | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minEocd = 22;
  if (bytes.length < minEocd) return null;

  // The end-of-central-directory record is in the last 22 + 65535 (comment) bytes.
  let eocd = -1;
  for (let i = bytes.length - minEocd; i >= Math.max(0, bytes.length - minEocd - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const entryCount = view.getUint16(eocd + 10, true);
  if (entryCount > MAX_ENTRIES) return null;
  let offset = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  let totalUncompressed = 0;
  const decoder = new TextDecoder();

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) return null;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const declaredSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    if (offset + 46 + nameLength > bytes.length) return null;
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.push({ name, method, compressedSize, declaredSize, localHeaderOffset });
    totalUncompressed += declaredSize;
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { names: entries.map((e) => e.name), entries, totalUncompressed };
}

export type ExpansionCheck = { ok: true; totalBytes: number } | { ok: false; reason: "too-large" | "unsupported" | "corrupt" };

/** Decompresses every entry (output discarded) and fails as soon as the total exceeds `budget`. */
export function verifyZipExpansion(bytes: Uint8Array, summary: ZipEntrySummary, budget: number): ExpansionCheck {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let total = 0;
  for (const entry of summary.entries) {
    if (entry.compressedSize === 0xffffffff || entry.declaredSize === 0xffffffff) return { ok: false, reason: "unsupported" }; // ZIP64
    const local = entry.localHeaderOffset;
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) return { ok: false, reason: "corrupt" };
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > bytes.length) return { ok: false, reason: "corrupt" };
    const data = bytes.subarray(dataStart, dataEnd);
    const remaining = budget - total;
    if (entry.method === 0) {
      total += data.byteLength;
    } else if (entry.method === 8) {
      try {
        total += inflateRawSync(data, { maxOutputLength: Math.max(1, remaining + 1) }).byteLength;
      } catch (error) {
        if (error instanceof RangeError || (error as NodeJS.ErrnoException)?.code === "ERR_BUFFER_TOO_LARGE") return { ok: false, reason: "too-large" };
        return { ok: false, reason: "corrupt" };
      }
    } else {
      return { ok: false, reason: "unsupported" };
    }
    if (total > budget) return { ok: false, reason: "too-large" };
  }
  return { ok: true, totalBytes: total };
}
