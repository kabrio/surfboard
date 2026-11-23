import { utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';
import { terminalInputSchema, terminalSizeSchema } from '../shared/protocol';

export type TerminalListener = (
  event:
    | { type: 'data'; tabId: string; data: string; revision: number }
    | { type: 'started'; tabId: string; pid: number }
    | {
        type: 'exit';
        tabId: string;
        exitCode: number;
        signal?: number;
      },
) => void;

export class TerminalManager {
  private readonly worker: UtilityProcess;
  private readonly activeTabs = new Set<string>();
  private readonly buffers = new Map<
    string,
    { data: string; revision: number }
  >();
  private listener: TerminalListener = () => undefined;

  constructor() {
    this.worker = utilityProcess.fork(
      path.join(__dirname, 'pty-worker.cjs'),
      [],
      { serviceName: 'surfboard-pty' },
    );
    this.worker.on('message', (event) => {
      if (event.type === 'data') {
        const existing = this.buffers.get(event.tabId) ?? {
          data: '',
          revision: 0,
        };
        existing.data = `${existing.data}${event.data}`.slice(-1_000_000);
        existing.revision += 1;
        this.buffers.set(event.tabId, existing);
        this.listener({ ...event, revision: existing.revision });
      } else {
        this.listener(event);
        if (event.type === 'exit') {
          this.activeTabs.delete(event.tabId);
        }
      }
    });
  }

  onEvent(listener: TerminalListener): void {
    this.listener = listener;
  }

  create(tabId: string, cwd?: string): void {
    if (this.activeTabs.has(tabId)) return;
    this.activeTabs.add(tabId);
    this.worker.postMessage({
      type: 'spawn',
      tabId,
      cols: 100,
      rows: 30,
      cwd,
    });
  }

  input(value: unknown): void {
    const input = terminalInputSchema.parse(value);
    if (!this.activeTabs.has(input.tabId)) {
      throw new Error(`Terminal ${input.tabId} is not active`);
    }
    this.worker.postMessage({ type: 'input', ...input });
  }

  resize(value: unknown): void {
    const size = terminalSizeSchema.parse(value);
    if (!this.activeTabs.has(size.tabId)) return;
    this.worker.postMessage({ type: 'resize', ...size });
  }

  close(tabId: string): void {
    if (!this.activeTabs.has(tabId)) return;
    this.activeTabs.delete(tabId);
    this.buffers.delete(tabId);
    this.worker.postMessage({ type: 'close', tabId });
  }

  buffer(tabId: string): { data: string; revision: number } {
    return this.buffers.get(tabId) ?? { data: '', revision: 0 };
  }

  acknowledge(tabId: string): void {
    if (!this.activeTabs.has(tabId)) return;
    this.worker.postMessage({ type: 'ack', tabId });
  }

  dispose(): void {
    for (const tabId of this.activeTabs) {
      this.worker.postMessage({ type: 'close', tabId });
    }
    this.worker.kill();
  }
}
