import { spawn, type IPty } from 'node-pty';
import { homedir } from 'node:os';

type WorkerRequest =
  | {
      type: 'spawn';
      tabId: string;
      cols: number;
      rows: number;
      cwd?: string;
    }
  | { type: 'input'; tabId: string; data: string }
  | { type: 'resize'; tabId: string; cols: number; rows: number }
  | { type: 'ack'; tabId: string }
  | { type: 'close'; tabId: string };

const sessions = new Map<string, IPty>();
const output = new Map<
  string,
  { queue: string; inFlight: boolean; timer?: NodeJS.Timeout }
>();
const port = process.parentPort;

if (!port) {
  throw new Error('PTY worker must be launched as an Electron utility process');
}

function shellForPlatform(): string {
  if (process.env.SHELL) return process.env.SHELL;
  return process.platform === 'win32' ? 'powershell.exe' : '/bin/bash';
}

port.on('message', ({ data }: { data: WorkerRequest }) => {
  if (data.type === 'spawn') {
    if (sessions.has(data.tabId)) return;
    const pty = spawn(shellForPlatform(), [], {
      cols: data.cols,
      rows: data.rows,
      cwd: data.cwd || homedir(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    });

    sessions.set(data.tabId, pty);
    port.postMessage({ type: 'started', tabId: data.tabId, pid: pty.pid });
    const state = { queue: '', inFlight: false };
    output.set(data.tabId, state);
    pty.onData((chunk) => {
      state.queue += chunk;
      flush(data.tabId, pty, state);
    });
    pty.onExit(({ exitCode, signal }) => {
      sessions.delete(data.tabId);
      const pending = output.get(data.tabId);
      if (pending?.timer) clearTimeout(pending.timer);
      output.delete(data.tabId);
      port.postMessage({
        type: 'exit',
        tabId: data.tabId,
        exitCode,
        signal,
      });
    });
    return;
  }

  const pty = sessions.get(data.tabId);
  if (!pty) return;
  if (data.type === 'input') pty.write(data.data);
  if (data.type === 'resize') pty.resize(data.cols, data.rows);
  if (data.type === 'ack') {
    const state = output.get(data.tabId);
    if (!state) return;
    state.inFlight = false;
    if (state.queue) flush(data.tabId, pty, state);
    else pty.resume();
  }
  if (data.type === 'close') {
    sessions.delete(data.tabId);
    const pending = output.get(data.tabId);
    if (pending?.timer) clearTimeout(pending.timer);
    output.delete(data.tabId);
    pty.kill();
  }
});

function flush(
  tabId: string,
  pty: IPty,
  state: { queue: string; inFlight: boolean; timer?: NodeJS.Timeout },
): void {
  if (state.inFlight || !state.queue) return;
  if (!state.timer) {
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (state.inFlight || !state.queue) return;
      const chunk = state.queue.slice(0, 64_000);
      state.queue = state.queue.slice(chunk.length);
      state.inFlight = true;
      pty.pause();
      port.postMessage({ type: 'data', tabId, data: chunk });
    }, 12);
  }
}

process.on('exit', () => {
  for (const pty of sessions.values()) pty.kill();
});
