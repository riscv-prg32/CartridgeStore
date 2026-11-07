// Write a PRG32 firmware release onto an ESP32-C6 over USB (Web Serial).
// Contract: PRG32 docs/usage/firmware_releases.md (prg32-firmware-release-1.0)
// and docs/software/web_usb_deployment.md, "Firmware flashing".
//
// The release files come from this Store (/api/firmware/...), which fetches
// them from GitHub, so the page never contacts another site. The page talks to
// the chip's ROM bootloader through Espressif's esptool-js, which also does the
// reset into the bootloader and back: this file never changes DTR or RTS.
import { ESPLoader, Transport } from '/static/vendor/esptool-js/esptool-0.6.1.js';

const RELEASE_FORMAT = 'prg32-firmware-release-1.0';
const REQUIRED_ROLES = ['bootloader', 'partition-table', 'app'];
const ESPRESSIF_USB = { usbVendorId: 0x303a, usbProductId: 0x1001 };
const BAUD_RATE = 460800;

const panel = document.getElementById('firmwareFlash');
let releases = [];
let busy = false;

function element(id) {
  return document.getElementById(id);
}

function hexDigest(buffer) {
  return Array.from(new Uint8Array(buffer)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function setStatus(text, kind = '') {
  const status = element('firmwareStatus');
  status.textContent = text;
  status.className = 'usb-status' + (kind ? ' ' + kind : '');
}

function log(text) {
  const box = element('firmwareLog');
  box.hidden = false;
  box.textContent = (box.textContent + text + '\n').slice(-12000);
}

function setProgress(done, total) {
  const bar = element('firmwareProgress');
  bar.hidden = false;
  bar.value = total ? Math.round(done * 100 / total) : 0;
}

function supported() {
  return Boolean(window.isSecureContext && navigator.serial);
}

function selectedRelease() {
  return releases.find(release => release.tag === element('firmwareRelease').value);
}

function selectedProfile() {
  const release = selectedRelease();
  return release && release.profiles.find(profile => profile.name === element('firmwareProfile').value);
}

function ready() {
  element('firmwareStart').disabled = busy || !supported() || !selectedProfile() || !element('firmwareConfirm').checked;
}

function showProfile() {
  const release = selectedRelease();
  const profile = selectedProfile();
  const warning = element('firmwareWarning');
  element('firmwareConfirm').checked = false;
  if (!release || !profile) {
    element('firmwareDetails').textContent = '';
    warning.hidden = true;
    ready();
    return;
  }
  const abi = release.abi || {};
  element('firmwareDetails').textContent = release.version + ' (published ' + (release.published || 'unknown')
    + ', cartridge ABI ' + abi.major + '.' + abi.minor + '): ' + (profile.description || profile.name) + '.';
  warning.textContent = profile.warning ? 'Warning: ' + profile.warning : '';
  warning.hidden = !profile.warning;
  ready();
}

function fillProfiles() {
  const release = selectedRelease();
  const select = element('firmwareProfile');
  select.replaceChildren();
  for (const profile of (release ? release.profiles : [])) {
    const option = document.createElement('option');
    option.value = profile.name;
    option.textContent = profile.name;
    select.append(option);
  }
  select.disabled = !release;
  showProfile();
}

async function loadReleases() {
  const select = element('firmwareRelease');
  try {
    const response = await fetch('/api/firmware/releases', { cache: 'no-store', credentials: 'same-origin' });
    const answer = await response.json();
    if (!response.ok) throw new Error(answer.error || ('HTTP ' + response.status));
    releases = answer.releases || [];
  } catch (error) {
    select.replaceChildren(new Option('No releases', ''));
    setStatus('The firmware releases could not be loaded: ' + error.message, 'error');
    return;
  }
  select.replaceChildren();
  for (const release of releases) {
    select.append(new Option(release.tag + (release.prerelease ? ' (pre-release)' : '')
      + (release.published ? ' - ' + release.published : ''), release.tag));
  }
  if (!releases.length) {
    select.append(new Option('No releases', ''));
    setStatus('No PRG32 firmware release is available yet.', 'error');
  }
  select.disabled = !releases.length;
  fillProfiles();
}

// The manifest and every part are checked here as well as on the Store, so a
// damaged download is never written.
async function releaseFiles(release, profileName) {
  const response = await fetch(release.manifest_url, { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new Error('The release manifest could not be downloaded (' + response.status + ').');
  const manifest = await response.json();
  if (manifest.format !== RELEASE_FORMAT || manifest.chip !== 'esp32c6') {
    throw new Error('This release is not a ' + RELEASE_FORMAT + ' ESP32-C6 release. Nothing was written.');
  }
  const profile = (manifest.profiles || []).find(item => item.name === profileName);
  const parts = profile ? profile.parts : [];
  if (!profile || REQUIRED_ROLES.some(role => !parts.find(part => part.role === role))) {
    throw new Error('The release has no complete ' + profileName + ' firmware. Nothing was written.');
  }
  const base = release.manifest_url.slice(0, release.manifest_url.lastIndexOf('/') + 1);
  const files = [];
  for (const part of [...parts].sort((a, b) => parseInt(a.offset, 16) - parseInt(b.offset, 16))) {
    const address = parseInt(part.offset, 16);
    if (address >= 0x9000 && address < 0x10000) throw new Error('The release would overwrite the settings. Nothing was written.');
    setStatus('Downloading ' + part.role + ' (' + part.size + ' bytes)…');
    const download = await fetch(base + encodeURIComponent(part.file), { credentials: 'same-origin' });
    if (!download.ok) throw new Error(part.file + ' could not be downloaded (' + download.status + ').');
    const data = new Uint8Array(await download.arrayBuffer());
    if (data.length !== part.size || hexDigest(await crypto.subtle.digest('SHA-256', data)) !== part.sha256) {
      throw new Error(part.file + ' does not match the release manifest. Nothing was written.');
    }
    files.push({ data, address, role: part.role });
  }
  return { manifest, files };
}

async function flash() {
  const release = selectedRelease();
  const profile = selectedProfile();
  if (!release || !profile) return;
  const eraseAll = element('firmwareEraseAll').checked;
  if (profile.warning && !window.confirm(profile.warning + '\n\nWrite ' + profile.name + ' anyway?')) return;
  if (eraseAll && !window.confirm('Erase the whole flash? The Wi-Fi settings, all eight cartridges and the scores on the console will be deleted.')) return;

  busy = true;
  ready();
  element('firmwareLog').textContent = '';
  element('firmwareLog').hidden = true;
  setProgress(0, 0);
  let transport = null;
  try {
    setStatus('Choose the PRG32 in the browser window.');
    // Asked first, while the click still counts as the user gesture Web Serial needs.
    const port = await navigator.serial.requestPort({ filters: [ESPRESSIF_USB] });
    const { manifest, files } = await releaseFiles(release, profile.name);
    log('Release ' + manifest.version + ', profile ' + profile.name + ', ' + files.length + ' parts verified');

    transport = new Transport(port, false);
    const terminal = { clean() {}, writeLine(text) { log(text); }, write(text) { if (text.trim()) log(text); } };
    const loader = new ESPLoader({ transport, baudrate: BAUD_RATE, terminal, debugLogging: false });
    setStatus('Starting the ESP32-C6 bootloader…');
    const chip = await loader.main('default_reset');
    if (!/ESP32-C6/i.test(chip)) throw new Error('This board is a ' + chip + ', not an ESP32-C6. Nothing was written.');
    if (eraseAll) {
      setStatus('Erasing the whole flash…');
      await loader.eraseFlash();
    }
    const total = files.reduce((sum, file) => sum + file.data.length, 0);
    const before = files.map((file, index) => files.slice(0, index).reduce((sum, item) => sum + item.data.length, 0));
    setStatus('Writing the firmware… do not unplug the console.');
    await loader.writeFlash({
      fileArray: files.map(file => ({ data: file.data, address: file.address })),
      flashMode: manifest.flash.flash_mode || 'dio',
      flashFreq: manifest.flash.flash_freq || '80m',
      flashSize: manifest.flash.flash_size || '4MB',
      eraseAll: false,
      compress: true,
      reportProgress: (index, written, size) => setProgress(before[index] + written * files[index].data.length / size, total),
    });
    await loader.after('hard_reset');
    setProgress(1, 1);
    setStatus('The console now runs PRG32 ' + manifest.version + ' (' + profile.name + '). If the screen stays dark,'
      + ' press RESET once.', 'ok');
  } catch (error) {
    const message = error && error.name === 'NotFoundError'
      ? 'No USB device was selected; nothing was written.'
      : (error && error.message) || String(error);
    setStatus(message, 'error');
    log(message);
  } finally {
    if (transport) {
      try { await transport.disconnect(); } catch (error) { /* the port is already closed */ }
    }
    busy = false;
    element('firmwareConfirm').checked = false;
    element('firmwareEraseAll').checked = false;
    ready();
  }
}

if (panel) {
  if (!supported()) element('firmwareUnsupported').hidden = false;
  element('firmwareRelease').addEventListener('change', fillProfiles);
  element('firmwareProfile').addEventListener('change', showProfile);
  element('firmwareConfirm').addEventListener('change', ready);
  element('firmwareStart').addEventListener('click', flash);
  loadReleases();
}
