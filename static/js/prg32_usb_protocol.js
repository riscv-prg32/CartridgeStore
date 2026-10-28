// PRG32 Web Serial client for the resident-firmware prg32-io-1.0 protocol.
//
// Shared file: PRG32-Construction-Kit static/js/prg32_usb_protocol.js and
// CartridgeStore static/js/prg32_usb_protocol.js must stay byte-identical.
// Contract: PRG32 docs/software/usb_protocol.md (wire format) and
// docs/software/web_usb_deployment.md (browser rules).
export const CLIENT_VERSION = '2026-10-29';

export const MESSAGE = Object.freeze({
  HELLO: 0x01, UPLOAD_BEGIN: 0x02, UPLOAD_DATA: 0x03, UPLOAD_END: 0x04,
  RUN: 0x05, DEBUG: 0x06, PERFORMANCE_GET: 0x07, STATUS: 0x80, RESULT_DATA: 0x81
});
export const MAGIC = new Uint8Array([0x50, 0x52, 0x47, 0x33, 0x32, 0x49, 0x4f, 0x00]);
export const PROTOCOL = 'prg32-io-1.0';
// Header flag bit 0: final chunk on replies, restart on PERFORMANCE_GET requests.
export const FLAG_FINAL = 0x0001;
export const FLAG_RESTART = 0x0001;
// Espressif USB Serial/JTAG, the ESP32-C6 native USB connector.
export const USB_FILTERS = Object.freeze([{ usbVendorId: 0x303a, usbProductId: 0x1001 }]);
export const SLOT_NAMES = Object.freeze(['cart0', 'cart1', 'cart2', 'cart3', 'cart4', 'cart5', 'cart6', 'cart7']);
export const SLOT_SIZE = 128 * 1024;

const HEADER_SIZE = 24;
const MAX_PAYLOAD = 16 * 1024;
const DEFAULT_CHUNK = 1024;
const MAX_CHUNK = 4096;
const CHUNK_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 15000;
const END_TIMEOUT_MS = 30000;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let number = 0; number < 256; number += 1) {
    let value = number;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[number] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export function encodeFrame(type, requestId, payload = new Uint8Array(), flags = 0) {
  if (payload.length > MAX_PAYLOAD) throw new Error('USB protocol payload is too large.');
  const frame = new Uint8Array(HEADER_SIZE + payload.length);
  frame.set(MAGIC);
  const view = new DataView(frame.buffer);
  view.setUint8(8, 1);
  view.setUint8(9, type);
  view.setUint16(10, flags, true);
  view.setUint32(12, requestId, true);
  view.setUint32(16, payload.length, true);
  view.setUint32(20, crc32(payload), true);
  frame.set(payload, HEADER_SIZE);
  return frame;
}

// Recovers whole frames from a byte stream that also carries firmware log text.
export class FrameDecoder {
  constructor() {
    this.buffer = new Uint8Array();
  }

  magicOffset() {
    for (let start = 0; start <= this.buffer.length - MAGIC.length; start += 1) {
      if (MAGIC.every((byte, index) => this.buffer[start + index] === byte)) return start;
    }
    return -1;
  }

  push(bytes) {
    const joined = new Uint8Array(this.buffer.length + bytes.length);
    joined.set(this.buffer);
    joined.set(bytes, this.buffer.length);
    this.buffer = joined;
  }

  // Returns the next valid frame, or null when more bytes are needed.
  next() {
    while (true) {
      const start = this.magicOffset();
      if (start < 0) {
        this.buffer = this.buffer.slice(Math.max(0, this.buffer.length - MAGIC.length + 1));
        return null;
      }
      if (start) this.buffer = this.buffer.slice(start);
      if (this.buffer.length < HEADER_SIZE) return null;
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
      const size = view.getUint32(16, true);
      if (view.getUint8(8) !== 1 || size > MAX_PAYLOAD) {
        this.buffer = this.buffer.slice(1);
        continue;
      }
      if (this.buffer.length < HEADER_SIZE + size) return null;
      const payload = this.buffer.slice(HEADER_SIZE, HEADER_SIZE + size);
      const frame = { type: view.getUint8(9), flags: view.getUint16(10, true), requestId: view.getUint32(12, true), payload };
      const expectedCrc = view.getUint32(20, true);
      this.buffer = this.buffer.slice(HEADER_SIZE + size);
      if (crc32(payload) === expectedCrc) return frame;
    }
  }
}

// Reads the fixed PRG2 header fields a browser needs before contacting a console.
export function cartridgeInfo(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 80) return { valid: false, size: bytes ? bytes.length : 0, name: 'PRG32 cartridge' };
  const magic = String.fromCharCode(...bytes.slice(0, 4));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nameBytes = bytes.slice(40, 72);
  const end = nameBytes.indexOf(0);
  const name = new TextDecoder().decode(end < 0 ? nameBytes : nameBytes.slice(0, end)).trim();
  return {
    valid: magic === 'PRG2',
    size: bytes.length,
    abiMajor: view.getUint16(4, true),
    abiMinor: view.getUint16(6, true),
    name: name || 'PRG32 cartridge'
  };
}

// Lists why this cartridge cannot be sent to the console that answered HELLO.
// An empty list means it may be sent; nothing has been written yet.
export function cartridgeProblems(info, hello, command = 'store') {
  const problems = [];
  if (!info.valid) problems.push('This file is not a PRG32 cartridge.');
  if (info.size > SLOT_SIZE) problems.push('The cartridge is larger than a 128 KiB slot.');
  if (!hello || hello.protocol !== PROTOCOL) {
    problems.push('The device does not speak the PRG32 USB protocol ' + PROTOCOL + '.');
    return problems;
  }
  const runtime = hello.runtime || {};
  if (runtime.cart_abi_major !== undefined && info.valid && info.abiMajor !== runtime.cart_abi_major) {
    problems.push('The cartridge needs ABI ' + info.abiMajor + ' but this PRG32 runs ABI ' + runtime.cart_abi_major + '.');
  }
  if (runtime.cart_max_size && info.size > runtime.cart_max_size) {
    problems.push('The cartridge takes ' + info.size + ' bytes; this PRG32 accepts at most ' + runtime.cart_max_size + '.');
  }
  if (command === 'debug' && !hello.debug_supported) {
    problems.push('This PRG32 cannot instruction-debug cartridges; use PRG32-QT for debugging.');
  }
  if (command === 'performance' && !(hello.capabilities || []).includes('performance')) {
    problems.push('This PRG32 does not offer performance runs over USB.');
  }
  return problems;
}

// Reuses the only authorized PRG32 port, otherwise asks the user to pick one.
// Must be called from a click handler (Web Serial requires a user gesture).
export async function choosePort(serial = navigator.serial) {
  const authorized = (await serial.getPorts()).filter(port => {
    const info = port.getInfo ? port.getInfo() : {};
    return USB_FILTERS.some(filter => info.usbVendorId === filter.usbVendorId && info.usbProductId === filter.usbProductId);
  });
  if (authorized.length === 1) return authorized[0];
  return serial.requestPort({ filters: USB_FILTERS });
}

export function describeSerialError(error) {
  const name = error && error.name;
  if (name === 'NotFoundError') return 'No USB device was selected; nothing was written.';
  if (name === 'InvalidStateError' || name === 'NetworkError') {
    return 'The USB port is busy. Close serial monitors and other programs that use the PRG32, then try again.';
  }
  if (name === 'SecurityError') return 'The browser blocked USB access on this page. Open it over HTTPS or as localhost.';
  return error && error.message ? error.message : String(error);
}

export class ProtocolSession {
  constructor(port) {
    this.port = port;
    this.reader = null;
    this.writer = null;
    this.decoder = new FrameDecoder();
    this.pendingRead = null;
    this.requestId = 0;
    this.capabilities = null;
  }

  // The DTR and RTS lines are left exactly as the browser sets them at open.
  // Changing them one at a time resets an ESP32-C6 (usb_protocol.md#modem-control-lines).
  async open() {
    await this.port.open({ baudRate: 115200, bufferSize: 32768 });
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
  }

  async close() {
    try {
      if (this.reader) {
        await this.reader.cancel().catch(() => {});
        this.reader.releaseLock();
      }
      if (this.writer) {
        await this.writer.close().catch(() => {});
        this.writer.releaseLock();
      }
    } finally {
      this.reader = null;
      this.writer = null;
      this.pendingRead = null;
      await this.port.close().catch(() => {});
    }
  }

  // Keeps at most one read outstanding, so bytes that arrive after a timeout
  // are delivered to the next request instead of being lost.
  async next(deadline) {
    while (true) {
      const frame = this.decoder.next();
      if (frame) return frame;
      const wait = deadline - Date.now();
      if (wait <= 0) return null;
      if (!this.pendingRead) this.pendingRead = this.reader.read();
      let timer = null;
      const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ timeout: true }), wait); });
      const answer = await Promise.race([this.pendingRead, timeout]);
      clearTimeout(timer);
      if (answer.timeout) return null;
      this.pendingRead = null;
      if (answer.done) throw new Error('The PRG32 USB connection closed unexpectedly.');
      this.decoder.push(answer.value);
    }
  }

  async request(type, payload = new Uint8Array(), timeoutMs = REQUEST_TIMEOUT_MS, flags = 0) {
    this.requestId = (this.requestId + 1) >>> 0;
    const requestId = this.requestId;
    await this.writer.write(encodeFrame(type, requestId, payload, flags));
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const frame = await this.next(deadline);
      if (!frame) {
        const error = new Error('The PRG32 device did not answer the USB protocol request.');
        error.name = 'TimeoutError';
        throw error;
      }
      if (frame.requestId === requestId) return frame;
    }
  }

  status(frame) {
    if (frame.type !== MESSAGE.STATUS) throw new Error('The PRG32 device returned an unexpected response.');
    let value;
    try { value = JSON.parse(new TextDecoder().decode(frame.payload)); } catch (_) { throw new Error('The PRG32 device returned invalid status data.'); }
    if (!value.ok) throw new Error(value.error || 'The PRG32 device rejected the request.');
    return value;
  }

  async json(type, value, timeoutMs = REQUEST_TIMEOUT_MS) {
    return this.status(await this.request(type, new TextEncoder().encode(JSON.stringify(value)), timeoutMs));
  }

  async hello() {
    this.capabilities = this.status(await this.request(MESSAGE.HELLO));
    return this.capabilities;
  }

  chunkSize() {
    const offered = this.capabilities && Number(this.capabilities.max_chunk);
    return offered > 0 ? Math.min(offered, MAX_CHUNK) : DEFAULT_CHUNK;
  }

  // Sends a validated cartridge. metadata: { name, slot, command }.
  // onProgress(received, total) follows the device's acknowledgements.
  async upload(data, metadata, onProgress = () => {}) {
    if (!SLOT_NAMES.includes(metadata.slot)) throw new Error('Choose a slot from cart0 to cart7.');
    await this.json(MESSAGE.UPLOAD_BEGIN, { ...metadata, size: data.length, crc32: crc32(data) });
    const chunk = this.chunkSize();
    for (let offset = 0; offset < data.length; offset += chunk) {
      const piece = data.subarray(offset, Math.min(offset + chunk, data.length));
      const payload = new Uint8Array(4 + piece.length);
      new DataView(payload.buffer).setUint32(0, offset, true);
      payload.set(piece, 4);
      let frame;
      try {
        frame = await this.request(MESSAGE.UPLOAD_DATA, payload, CHUNK_TIMEOUT_MS);
      } catch (error) {
        if (error.name !== 'TimeoutError') throw error;
        // The reply was lost: the firmware acknowledges an identical resend
        // without writing the chunk twice.
        frame = await this.request(MESSAGE.UPLOAD_DATA, payload, REQUEST_TIMEOUT_MS);
      }
      const progress = this.status(frame);
      onProgress(progress.received ?? offset + piece.length, progress.total ?? data.length);
    }
    return this.json(MESSAGE.UPLOAD_END, { size: data.length }, END_TIMEOUT_MS);
  }

  async run(slot) {
    if (!SLOT_NAMES.includes(slot)) throw new Error('Choose a slot from cart0 to cart7.');
    return this.json(MESSAGE.RUN, { slot });
  }

  // Returns the performance JSON text. The first request restarts the
  // document so an interrupted earlier retrieval cannot leave a stale tail.
  async performance() {
    const output = [];
    let flags = FLAG_RESTART;
    while (true) {
      const frame = await this.request(MESSAGE.PERFORMANCE_GET, new Uint8Array(), REQUEST_TIMEOUT_MS, flags);
      flags = 0;
      if (frame.type === MESSAGE.STATUS) this.status(frame);
      if (frame.type !== MESSAGE.RESULT_DATA) throw new Error('The PRG32 device returned an unexpected performance response.');
      output.push(...frame.payload);
      if (frame.flags & FLAG_FINAL) break;
    }
    const text = new TextDecoder().decode(new Uint8Array(output));
    JSON.parse(text);
    return text;
  }
}
