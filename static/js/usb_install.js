// Install a published PRG32 cartridge on a console over USB (Web Serial).
// Contract: PRG32 docs/software/web_usb_deployment.md, "CartridgeStore integration".
// The console's resident firmware receives, verifies and stores the cartridge;
// nothing else on the console changes.
import {
  ProtocolSession, SLOT_NAMES, cartridgeInfo, cartridgeProblems, choosePort, describeSerialError
} from './prg32_usb_protocol.js';

const panel = document.getElementById('usbInstall');

function element(id) {
  return document.getElementById(id);
}

function hexDigest(buffer) {
  return Array.from(new Uint8Array(buffer)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function setStatus(text, kind = '') {
  const status = element('usbStatus');
  status.textContent = text;
  status.className = 'usb-status' + (kind ? ' ' + kind : '');
}

function log(text) {
  const box = element('usbLog');
  box.hidden = false;
  box.textContent = (box.textContent + text + '\n').slice(-8000);
}

function setProgress(received, total) {
  const bar = element('usbProgress');
  bar.hidden = false;
  bar.value = total ? Math.round(received * 100 / total) : 0;
}

let busy = false;

function supported() {
  return Boolean(window.isSecureContext && navigator.serial);
}

function ready() {
  const button = element('usbInstallStart');
  button.disabled = busy || !supported() || !element('usbConfirm').checked || !panel.dataset.sha256;
}

// Downloads through the normal endpoint (which counts the download) and
// checks the bytes against the catalog's recorded SHA-256 and size.
async function cartridgeBytes() {
  const url = '/api/games/' + encodeURIComponent(panel.dataset.game) + '/download?architecture=esp32c6&version='
    + encodeURIComponent(panel.dataset.version);
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error('The cartridge could not be downloaded (' + response.status + ').');
  const data = new Uint8Array(await response.arrayBuffer());
  if (String(data.length) !== panel.dataset.size) {
    throw new Error('The downloaded cartridge has the wrong size. Reload the page and try again.');
  }
  if (hexDigest(await crypto.subtle.digest('SHA-256', data)) !== panel.dataset.sha256) {
    throw new Error('The downloaded cartridge does not match the catalog record. Nothing was written.');
  }
  return data;
}

async function install() {
  const slot = element('usbSlot').value;
  const command = element('usbCommand').value;
  if (!SLOT_NAMES.includes(slot) || !['store', 'run'].includes(command)) return;
  busy = true;
  ready();
  element('usbLog').textContent = '';
  element('usbLog').hidden = true;
  setProgress(0, 0);
  let session = null;
  try {
    setStatus('Choose the PRG32 in the browser window.');
    // The port is requested first, while the click still counts as the user
    // gesture Web Serial requires.
    session = new ProtocolSession(await choosePort(navigator.serial));
    await session.open();
    setStatus('Downloading and checking the cartridge…');
    const data = await cartridgeBytes();
    const info = cartridgeInfo(data);
    setStatus('Asking the PRG32 what it accepts…');
    const capabilities = await session.hello();
    log('PRG32 firmware ' + (capabilities.firmware || 'unknown') + ' (' + (capabilities.target || 'unknown target') + ')');
    const problems = cartridgeProblems(info, capabilities, command);
    if (problems.length) throw new Error(problems.join(' ') + ' Nothing was written.');
    log(info.name + ': ' + info.size + ' bytes, ABI ' + info.abiMajor + '.' + info.abiMinor + ' -> ' + slot + ' (' + command + ')');
    setStatus('Writing ' + slot + '… the PRG32 shows the progress too.');
    const result = await session.upload(data, { name: info.name, slot, command }, setProgress);
    setProgress(1, 1);
    setStatus(result.running
      ? slot + ' holds ' + panel.dataset.title + ' and it is running.'
      : slot + ' holds ' + panel.dataset.title + '. The PRG32 is back in setup.', 'ok');
  } catch (error) {
    const message = describeSerialError(error);
    setStatus(message, 'error');
    log(message);
  } finally {
    if (session) await session.close();
    busy = false;
    element('usbConfirm').checked = false;
    ready();
  }
}

if (panel) {
  if (!supported()) element('usbUnsupported').hidden = false;
  if (!panel.dataset.sha256) setStatus('This cartridge has no recorded digest, so it cannot be installed over USB.', 'error');
  element('usbConfirm').addEventListener('change', ready);
  element('usbSlot').addEventListener('change', () => { element('usbConfirm').checked = false; ready(); });
  element('usbCommand').addEventListener('change', ready);
  element('usbInstallStart').addEventListener('click', install);
  ready();
}
