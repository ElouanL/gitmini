#!/usr/bin/env node
// Generates the minimum icons of hello-tauri (united, non-dependent): icons/{32x32,128x128,icon}.png and icons/icon.ico.
// Tauri requires valid PNG RGBA (and a .ico on Windows); the ICO features a PNG (valid from Windows Vista).
//   node tests/perf/hello-tauri/gen-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'icons');

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** PNG RGBA 8 bits, couleur unie. */
export function solidPng(size, [r, g, b, a]) {
  const row = Buffer.alloc(1 + size * 4);
  for (let x = 0; x < size; x++) row.set([r, g, b, a], 1 + x * 4);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8 bits, RGBA, deflate, filter 0, without interlacing
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** ICO with a PNG image (size ≤ 256). */
export function pngIco(png, size) {
  const head = Buffer.alloc(6 + 16);
  head.writeUInt16LE(0, 0); // reserved
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(1, 4); // one image
  head[6] = size >= 256 ? 0 : size;
  head[7] = size >= 256 ? 0 : size;
  head.writeUInt16LE(1, 10); // plans
  head.writeUInt16LE(32, 12); // bits par pixel
  head.writeUInt32LE(png.length, 14);
  head.writeUInt32LE(22, 18); // data offset
  return Buffer.concat([head, png]);
}

mkdirSync(DIR, { recursive: true });
const color = [45, 212, 191, 255];
for (const [name, size] of [['32x32.png', 32], ['128x128.png', 128], ['icon.png', 256]]) writeFileSync(join(DIR, name), solidPng(size, color));
writeFileSync(join(DIR, 'icon.ico'), pngIco(solidPng(64, color), 64));
console.log(`icons written in ${DIR}`);
