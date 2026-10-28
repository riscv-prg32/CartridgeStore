// A pretend PRG32 behind Web Serial, for tests only.
//
// Plain script (no import/export) so it runs both under Node (imported for its
// side effect) and in a real browser (Playwright add_init_script). It follows
// the firmware receiver in PRG32 components/prg32/prg32_usb_protocol.c closely
// enough for the browser client: framing, CRC, ordered chunks, an identical
// resend, refusals before erase, and the performance restart flag.
(function install(root) {
  const MAGIC = [0x50, 0x52, 0x47, 0x33, 0x32, 0x49, 0x4f, 0x00];
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let v = n;
    for (let b = 0; b < 8; b += 1) v = (v & 1) ? (0xedb88320 ^ (v >>> 1)) : (v >>> 1);
    table[n] = v >>> 0;
  }
  function crc32(bytes) {
    let v = 0xffffffff;
    for (const byte of bytes) v = table[(v ^ byte) & 0xff] ^ (v >>> 8);
    return (v ^ 0xffffffff) >>> 0;
  }
  function frame(type, requestId, payload, flags) {
    const out = new Uint8Array(24 + payload.length);
    out.set(MAGIC);
    const view = new DataView(out.buffer);
    view.setUint8(8, 1);
    view.setUint8(9, type);
    view.setUint16(10, flags, true);
    view.setUint32(12, requestId, true);
    view.setUint32(16, payload.length, true);
    view.setUint32(20, crc32(payload), true);
    out.set(payload, 24);
    return out;
  }
  const json = value => new TextEncoder().encode(JSON.stringify(value));

  function createFakePrg32Port(options = {}) {
    const device = {
      hello: Object.assign({
        ok: true, protocol: 'prg32-io-1.0', capabilities: ['upload', 'run', 'performance'],
        debug_supported: false, firmware: 'fake', target: 'esp32c6', slots: 8,
        max_chunk: 4096, max_payload: 16384,
        runtime: { cart_ram_size: 65536, cart_max_size: 65536, cart_abi_major: 1, cart_abi_minor: 1 }
      }, options.hello || {}),
      slots: {},
      upload: null,
      chunkSizes: [],
      dataRequests: 0,
      dropReplies: options.dropReplies || [],
      performanceChunks: options.performanceChunks || ['{"cases":', '[]}'],
      performanceIndex: 0,
      performanceFlags: [],
      requests: [],
      setSignalsCalls: 0,
      opened: 0,
      closed: 0,
      silent: Boolean(options.silent)
    };
    let controller = null;
    let input = new Uint8Array();
    const reply = (type, id, payload, flags = 1) => controller && controller.enqueue(frame(type, id, payload, flags));

    function handle(type, flags, id, payload) {
      device.requests.push(type);
      if (device.silent) return;
      const text = () => JSON.parse(new TextDecoder().decode(payload) || '{}');
      if (type === 0x01) return reply(0x80, id, json(device.hello));
      if (type === 0x02) {
        const meta = text();
        if (!/^cart[0-7]$/.test(meta.slot) || !['store', 'run', 'debug', 'performance'].includes(meta.command)) {
          return reply(0x80, id, json({ ok: false, error: 'invalid upload metadata' }));
        }
        if (meta.command === 'debug' && !device.hello.debug_supported) {
          return reply(0x80, id, json({ ok: false, error: 'debug execution is available in PRG32-Qt only' }));
        }
        device.upload = { meta, received: [], size: 0 };
        return reply(0x80, id, json({ ok: true, message: 'upload accepted' }));
      }
      if (type === 0x03) {
        device.dataRequests += 1;
        const offset = new DataView(payload.buffer, payload.byteOffset).getUint32(0, true);
        const data = payload.slice(4);
        const upload = device.upload;
        if (!upload) return reply(0x80, id, json({ ok: false, error: 'no upload in progress' }));
        if (offset + data.length === upload.size) {
          // identical resend after a lost reply
        } else if (offset !== upload.size) {
          return reply(0x80, id, json({ ok: false, error: 'out-of-order upload chunk' }));
        } else {
          upload.received.push(...data);
          upload.size += data.length;
          device.chunkSizes.push(data.length);
        }
        if (device.dropReplies.includes(device.dataRequests)) return;
        return reply(0x80, id, json({ ok: true, received: upload.size, total: upload.meta.size }));
      }
      if (type === 0x04) {
        const upload = device.upload;
        const bytes = new Uint8Array(upload ? upload.received : []);
        device.upload = null;
        if (!upload || bytes.length !== upload.meta.size || crc32(bytes) !== upload.meta.crc32) {
          return reply(0x80, id, json({ ok: false, error: 'upload length or checksum mismatch' }));
        }
        device.slots[upload.meta.slot] = bytes;
        const running = upload.meta.command === 'run' || upload.meta.command === 'performance';
        return reply(0x80, id, json({ ok: true, name: upload.meta.name, slot: upload.meta.slot, size: bytes.length, running }));
      }
      if (type === 0x07) {
        device.performanceFlags.push(flags);
        if (flags & 1) device.performanceIndex = 0;
        const index = device.performanceIndex;
        device.performanceIndex += 1;
        const last = index === device.performanceChunks.length - 1;
        return reply(0x81, id, new TextEncoder().encode(device.performanceChunks[index]), last ? 1 : 0);
      }
      return reply(0x80, id, json({ ok: false, error: 'unsupported protocol message' }));
    }

    function consume(bytes) {
      const joined = new Uint8Array(input.length + bytes.length);
      joined.set(input);
      joined.set(bytes, input.length);
      input = joined;
      while (input.length >= 24) {
        const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
        const size = view.getUint32(16, true);
        if (input.length < 24 + size) return;
        const payload = input.slice(24, 24 + size);
        const ok = crc32(payload) === view.getUint32(20, true);
        const type = view.getUint8(9), flags = view.getUint16(10, true), id = view.getUint32(12, true);
        input = input.slice(24 + size);
        if (ok) handle(type, flags, id, payload);
        else reply(0x80, id, json({ ok: false, error: 'payload checksum mismatch' }));
      }
    }

    const port = {
      device,
      getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }),
      async open() {
        device.opened += 1;
        this.readable = new ReadableStream({
          start(c) {
            controller = c;
            // Firmware log text shares the stream; the client must skip it.
            c.enqueue(new TextEncoder().encode('I (1234) prg32_main: idle heartbeat\n'));
          }
        });
        this.writable = new WritableStream({ write(chunk) { consume(new Uint8Array(chunk)); } });
      },
      async setSignals() { device.setSignalsCalls += 1; },
      async close() { device.closed += 1; controller = null; }
    };
    return port;
  }

  function installFakeSerial(target, options = {}) {
    const port = createFakePrg32Port(options);
    const serial = {
      port,
      authorized: options.authorized ? [port] : [],
      requestPortFilters: null,
      async getPorts() { return this.authorized; },
      async requestPort(request) {
        this.requestPortFilters = request && request.filters;
        if (options.cancelChooser) {
          const error = new Error('No port selected by the user.');
          error.name = 'NotFoundError';
          throw error;
        }
        this.authorized = [port];
        return port;
      }
    };
    Object.defineProperty(target, 'serial', { value: serial, configurable: true });
    return serial;
  }

  root.createFakePrg32Port = createFakePrg32Port;
  root.installFakeSerial = installFakeSerial;
})(globalThis);
