import assert from "node:assert/strict";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { image } from "./fixtures.js";
import { syntheticImage } from "../scripts/synthetic-image.mjs";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test("synthetic PNG fixture has valid chunk checksums and decompresses to one RGBA pixel", () => {
  const bytes = Buffer.from(image.split(",")[1], "base64");
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString();
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    assert.equal(crc32(bytes.subarray(offset + 4, offset + 8 + length)), bytes.readUInt32BE(offset + 8 + length));
    chunks.push({ type, data });
    offset += length + 12;
  }
  assert.deepEqual(chunks.map((chunk) => chunk.type), ["IHDR", "IDAT", "IEND"]);
  assert.equal(chunks[0].data.readUInt32BE(0), 1);
  assert.equal(chunks[0].data.readUInt32BE(4), 1);
  assert.equal(chunks[0].data[8], 8);
  assert.equal(chunks[0].data[9], 6);
  assert.deepEqual(inflateSync(chunks[1].data), Buffer.from([0, 0, 0, 255, 255]));
});

test("real smoke image is generated in memory with valid PNG chunks and known colored regions", () => {
  const bytes = Buffer.from(syntheticImage().split(",")[1], "base64");
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString();
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    assert.equal(crc32(bytes.subarray(offset + 4, offset + 8 + length)), bytes.readUInt32BE(offset + 8 + length));
    chunks.push({ type, data });
    offset += length + 12;
  }
  assert.equal(chunks[0].data.readUInt32BE(0), 640);
  assert.equal(chunks[0].data.readUInt32BE(4), 240);
  const rows = inflateSync(chunks.find((chunk) => chunk.type === "IDAT").data);
  assert.equal(rows.length, 240 * (640 * 4 + 1));
  const pixel = (x, y) => rows.subarray(y * (640 * 4 + 1) + 1 + x * 4, y * (640 * 4 + 1) + 1 + x * 4 + 4);
  assert.deepEqual(pixel(60, 110), Buffer.from([220, 30, 30, 255]));
  assert.deepEqual(pixel(345, 115), Buffer.from([20, 70, 200, 255]));
  assert.deepEqual(pixel(0, 0), Buffer.from([255, 255, 255, 255]));
});
