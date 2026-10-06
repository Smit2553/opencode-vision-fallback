import { deflateSync } from "node:zlib";

const FONT = {
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  N: ["10001", "11001", "11001", "10101", "10011", "10011", "10001"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  4: ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
};

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const content = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc32(content));
  return Buffer.concat([length, content, checksum]);
}

// Generated in memory, never read from a screenshot or personal file.
export function syntheticImage() {
  const width = 640;
  const height = 240;
  const pixels = Buffer.alloc(width * height * 4, 255);
  function rectangle(x, y, w, h, color) {
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
      const offset = (row * width + col) * 4;
      for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = color[channel];
    }
  }
  function text(value, x, y, scale, color) {
    for (const character of value) {
      for (const [row, line] of (FONT[character] ?? []).entries()) {
        for (const [col, pixel] of [...line].entries()) {
          if (pixel === "1") rectangle(x + col * scale, y + row * scale, scale, scale, color);
        }
      }
      x += 6 * scale;
    }
  }
  text("VISION TEST 42", 40, 30, 4, [0, 0, 0]);
  rectangle(50, 100, 80, 80, [220, 30, 30]);
  rectangle(340, 110, 210, 70, [20, 70, 200]);
  text("SAVE", 373, 124, 6, [255, 255, 255]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) pixels.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}
