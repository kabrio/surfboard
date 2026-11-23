import '@xterm/xterm/css/xterm.css';
import './terminal.css';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';

const HOST_NAME = 'com.kabrio.surfboard_terminal';
const statusElement = document.querySelector('#terminal-status');
const terminalElement = document.querySelector('#terminal');
const reconnectButton = document.querySelector('#reconnect');
const openTabButton = document.querySelector('#open-tab');
const encoder = new TextEncoder();

const terminal = new Terminal({
  allowProposedApi: true,
  cursorBlink: true,
  fontFamily:
    'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
  fontSize: 13,
  lineHeight: 1.25,
  scrollback: 20_000,
  smoothScrollDuration: 30,
  theme: {
    background: '#0c0c0c',
    foreground: '#e5e5e5',
    cursor: '#f4f4f2',
    selectionBackground: '#444',
  },
});
const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(terminalElement);
fitAddon.fit();
terminal.focus();

let port = null;
let connected = false;

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function setStatus(value, failed = false) {
  statusElement.textContent = value;
  statusElement.classList.toggle('failed', failed);
}

function showSetupHelp(error) {
  setStatus('Native host not connected', true);
  terminal.writeln('');
  terminal.writeln('\x1b[1;31mSURFBOARD native host unavailable.\x1b[0m');
  if (error) terminal.writeln(`Chrome reported: ${error}`);
  terminal.writeln('');
  terminal.writeln('From the SURFBOARD repository, run:');
  terminal.writeln('  npm run build:native-host');
  terminal.writeln('  npm run install:chrome-host -- <extension-id>');
  terminal.writeln('');
  terminal.writeln('Then reload this extension and reconnect.');
}

function disconnect() {
  if (port && connected) {
    try {
      port.postMessage({ type: 'close' });
    } catch {
      // The browser already closed the native connection.
    }
  }
  connected = false;
  port?.disconnect();
  port = null;
}

function connect() {
  disconnect();
  setStatus('Connecting to native host…');
  port = chrome.runtime.connectNative(HOST_NAME);
  const currentPort = port;

  currentPort.onMessage.addListener((message) => {
    if (message.type === 'opened') {
      connected = true;
      setStatus(`${message.shell} · pid ${message.pid}`);
      terminal.focus();
    } else if (message.type === 'data' && message.data) {
      terminal.write(base64ToBytes(message.data));
    } else if (message.type === 'exited') {
      connected = false;
      setStatus(`Shell exited (${message.status ?? 'unknown'})`, true);
    } else if (message.type === 'error') {
      connected = false;
      setStatus(message.message ?? 'Native host error', true);
      terminal.writeln(`\r\n${message.message ?? 'Native host error'}`);
    }
  });

  currentPort.onDisconnect.addListener(() => {
    if (port !== currentPort) return;
    connected = false;
    const error = chrome.runtime.lastError?.message;
    showSetupHelp(error);
  });

  currentPort.postMessage({
    type: 'open',
    cols: terminal.cols,
    rows: terminal.rows,
  });
}

terminal.onData((data) => {
  if (!port || !connected) return;
  port.postMessage({
    type: 'input',
    data: bytesToBase64(encoder.encode(data)),
  });
});

terminal.onResize(({ cols, rows }) => {
  if (port && connected) {
    port.postMessage({ type: 'resize', cols, rows });
  }
});

new ResizeObserver(() => {
  fitAddon.fit();
}).observe(terminalElement);

reconnectButton.addEventListener('click', () => {
  terminal.clear();
  connect();
});

openTabButton.addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('terminal.html') });
  window.close();
});

window.addEventListener('beforeunload', disconnect);
window.addEventListener('focus', () => terminal.focus());

connect();
