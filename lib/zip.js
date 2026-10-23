/**
 * 零依赖 ZIP 写入器。
 *
 * 只实现本插件需要的最小可用子集：STORE / DEFLATE 两种方法、UTF-8 文件名
 * （通用位标记 bit 11）、标准 EOCD。不支持 ZIP64、加密、分卷。
 *
 * 之所以不调 PowerShell 的 Compress-Archive：一是它按目录打包很难精确控制
 * 条目名与顺序，二是它会把整个目录先枚举再压缩、进度不可见，三是宿主插件
 * 不应该依赖外部 shell 才能产出交付物。
 *
 * 内存策略：条目内容一次性读入。本插件的载荷是插件源码与技能目录，单个
 * 文件远小于 MAX_ENTRY_BYTES；超过上限时直接报错而不是悄悄截断。
 */

import { createWriteStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import * as zlib from 'node:zlib';

const { deflateRawSync } = zlib;
const zlibCrc32 = typeof zlib.crc32 === 'function' ? zlib.crc32 : undefined;

/** 单个条目的内存上限（256 MiB）。超出即明确失败，避免静默损坏归档。 */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

/** ZIP 条目总数上限（不含 ZIP64 时的 65535 上限，这里留出余量）。 */
const MAX_ENTRIES = 65000;

// --- CRC-32 -----------------------------------------------------------------
// Node 22+ 的 zlib 自带 crc32；老运行时退回到查表实现，行为一致。

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32Fallback(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const crc32 = typeof zlibCrc32 === 'function' ? (buf) => zlibCrc32(buf) >>> 0 : crc32Fallback;

// --- DOS 时间戳 --------------------------------------------------------------

function dosDateTime(date) {
  const year = date.getFullYear();
  const dosYear = year < 1980 ? 0 : year - 1980;
  const time =
    ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = ((date.getMonth() + 1) & 0x0f) << 5 | (date.getDate() & 0x1f);
  return { time: time & 0xffff, date: (dosYear << 9) | day };
}

// --- 条目归一化 --------------------------------------------------------------

/** 把条目名规整成 ZIP 里合法的相对路径（正斜杠、无前导斜杠、无 `..`）。 */
export function normalizeEntryName(name) {
  const cleaned = String(name).replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = cleaned.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) throw new Error(`非法的条目路径：${name}`);
  return parts.join('/');
}

async function toEntry(spec) {
  const name = normalizeEntryName(spec.name);
  if (name === '') throw new Error('空的条目名');
  if (spec.dir === true) return { name: name.endsWith('/') ? name : `${name}/`, dir: true };

  const isPath = typeof spec.path === 'string';
  const data = isPath ? await readFile(spec.path) : Buffer.from(spec.data ?? '');
  if (data.length > MAX_ENTRY_BYTES) {
    throw new Error(`条目 ${name} 有 ${data.length} 字节，超过 ${MAX_ENTRY_BYTES} 字节上限`);
  }
  let mtime = spec.mtime;
  if (!(mtime instanceof Date) && isPath) {
    try {
      mtime = (await stat(spec.path)).mtime;
    } catch {
      mtime = undefined;
    }
  }
  return { name, data, mtime: mtime instanceof Date ? mtime : new Date() };
}

/**
 * 生成一个 ZIP 文件。
 *
 * @param {Array<{name: string, data?: Buffer|string, path?: string, dir?: boolean, mtime?: Date}>} specs
 * @param {string} outPath 目标 .zip 路径
 * @param {{onProgress?: (done: number, total: number, name: string) => void, level?: number}} [options]
 * @returns {Promise<{path: string, entries: number, bytes: number, compressedBytes: number}>}
 */
export async function writeZip(specs, outPath, options = {}) {
  if (specs.length > MAX_ENTRIES) throw new Error(`条目数 ${specs.length} 超过上限 ${MAX_ENTRIES}`);

  const central = [];
  let offset = 0;
  let rawBytes = 0;
  let compressedBytes = 0;

  const stream = createWriteStream(outPath);
  let streamError = null;
  let pendingReject = null;
  stream.on('error', (error) => {
    streamError = error;
    if (pendingReject !== null) {
      const reject = pendingReject;
      pendingReject = null;
      reject(error);
    }
  });
  const write = (chunk) =>
    new Promise((resolve, reject) => {
      if (streamError !== null) {
        reject(streamError);
        return;
      }
      if (stream.write(chunk)) {
        resolve();
        return;
      }
      pendingReject = reject;
      stream.once('drain', () => {
        pendingReject = null;
        resolve();
      });
    });

  try {
    let done = 0;
    for (const spec of specs) {
      const entry = await toEntry(spec);
      const { time, date } = dosDateTime(entry.mtime ?? new Date());
      const nameBuf = Buffer.from(entry.name, 'utf8');

      let method = 0;
      let body = Buffer.alloc(0);
      let raw = Buffer.alloc(0);
      let crc = 0;

      if (!entry.dir) {
        raw = entry.data;
        crc = crc32(raw);
        if (raw.length > 0) {
          const deflated = deflateRawSync(raw, { level: options.level ?? 9 });
          if (deflated.length < raw.length) {
            method = 8;
            body = deflated;
          } else {
            body = raw;
          }
        }
      }

      const flags = 0x0800; // UTF-8 文件名
      const localHeader = Buffer.alloc(30);
      localHeader.writeUInt32LE(0x04034b50, 0);
      localHeader.writeUInt16LE(20, 4);
      localHeader.writeUInt16LE(flags, 6);
      localHeader.writeUInt16LE(method, 8);
      localHeader.writeUInt16LE(time, 10);
      localHeader.writeUInt16LE(date, 12);
      localHeader.writeUInt32LE(crc, 14);
      localHeader.writeUInt32LE(body.length, 18);
      localHeader.writeUInt32LE(raw.length, 22);
      localHeader.writeUInt16LE(nameBuf.length, 26);
      localHeader.writeUInt16LE(0, 28);

      await write(localHeader);
      await write(nameBuf);
      if (body.length > 0) await write(body);

      const centralHeader = Buffer.alloc(46);
      centralHeader.writeUInt32LE(0x02014b50, 0);
      centralHeader.writeUInt16LE(20, 4);
      centralHeader.writeUInt16LE(20, 6);
      centralHeader.writeUInt16LE(flags, 8);
      centralHeader.writeUInt16LE(method, 10);
      centralHeader.writeUInt16LE(time, 12);
      centralHeader.writeUInt16LE(date, 14);
      centralHeader.writeUInt32LE(crc, 16);
      centralHeader.writeUInt32LE(body.length, 20);
      centralHeader.writeUInt32LE(raw.length, 24);
      centralHeader.writeUInt16LE(nameBuf.length, 28);
      centralHeader.writeUInt16LE(0, 30);
      centralHeader.writeUInt16LE(0, 32);
      centralHeader.writeUInt16LE(0, 34);
      centralHeader.writeUInt16LE(0, 36);
      centralHeader.writeUInt32LE(entry.dir ? 0x41ed0010 : 0x81a40000, 38);
      centralHeader.writeUInt32LE(offset, 42);
      central.push(centralHeader, nameBuf);

      offset += localHeader.length + nameBuf.length + body.length;
      rawBytes += raw.length;
      compressedBytes += body.length;

      done += 1;
      options.onProgress?.(done, specs.length, entry.name);
    }

    const centralBuf = Buffer.concat(central);
    await write(centralBuf);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(specs.length, 8);
    eocd.writeUInt16LE(specs.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);
    await write(eocd);

    await new Promise((resolve, reject) => {
      stream.end((error) => (error ? reject(error) : resolve()));
    });
    if (streamError !== null) throw streamError;
  } catch (error) {
    stream.destroy();
    throw error;
  }

  return { path: outPath, entries: specs.length, bytes: rawBytes, compressedBytes };
}

/** 把一个目录树展开成 ZIP 条目（自动跳过排除项）。 */
export async function collectDirectory(root, options = {}) {
  const { readdir } = await import('node:fs/promises');
  const path = await import('node:path');
  const exclude = options.exclude ?? (() => false);
  const prefix = options.prefix ?? '';
  const out = [];
  const walk = async (dir, rel) => {
    const items = await readdir(dir, { withFileTypes: true });
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const item of items) {
      const abs = path.join(dir, item.name);
      const relPath = rel === '' ? item.name : `${rel}/${item.name}`;
      if (exclude(relPath, item)) continue;
      if (item.isDirectory()) {
        await walk(abs, relPath);
      } else if (item.isFile()) {
        out.push({ name: prefix === '' ? relPath : `${prefix}/${relPath}`, path: abs });
      }
    }
  };
  await walk(root, '');
  return out;
}
