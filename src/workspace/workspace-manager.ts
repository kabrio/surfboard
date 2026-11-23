import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import type {
  Tab,
  WorkspaceSnapshot,
  WorkspaceWindow,
} from '../shared/protocol';
import { homedir } from 'node:os';
import { BrowserController } from '../browser/browser-controller';
import { TerminalManager } from '../terminal/terminal-manager';

type InternalWindow = {
  id: string;
  browserWindow: BrowserWindow;
  activeTabId: string | null;
  tabs: Tab[];
};

export class WorkspaceManager {
  private readonly windows = new Map<string, InternalWindow>();
  private readonly browser: BrowserController;
  private readonly terminal: TerminalManager;
  private changed: () => void = () => undefined;

  constructor() {
    this.browser = new BrowserController({
      onTabUpdate: (tabId, patch) => this.patchTab(tabId, patch),
      onOpenUrl: (windowId, url) => this.createTab(windowId, 'browser', url),
    });
    this.terminal = new TerminalManager();
    this.terminal.onEvent((event) => {
      if (event.type === 'data') {
        this.rendererForTab(event.tabId)?.webContents.send(
          'terminal:data',
          event,
        );
      } else if (event.type === 'started') {
        this.patchTab(event.tabId, { processId: event.pid, exited: false });
      } else {
        this.patchTab(event.tabId, { exited: true });
      }
    });
  }

  readonly browserController = (): BrowserController => this.browser;

  onChanged(listener: () => void): void {
    this.changed = listener;
  }

  addWindow(window: BrowserWindow): InternalWindow {
    const state: InternalWindow = {
      id: randomUUID(),
      browserWindow: window,
      activeTabId: null,
      tabs: [],
    };
    this.windows.set(state.id, state);
    return state;
  }

  windowIdFor(browserWindow: BrowserWindow): string | undefined {
    return [...this.windows.values()].find(
      (entry) => entry.browserWindow === browserWindow,
    )?.id;
  }

  initializeWindow(windowId: string, browserUrl = 'https://example.com'): void {
    if (this.requireWindow(windowId).tabs.length) return;
    this.createTab(windowId, 'browser', browserUrl);
    this.createTab(windowId, 'terminal');
    const first = this.requireWindow(windowId).tabs[0];
    if (first) this.activateTab(windowId, first.id);
  }

  restoreWindow(
    windowId: string,
    restored: WorkspaceWindow,
    urlOverride?: string,
  ): void {
    const window = this.requireWindow(windowId);
    if (window.tabs.length) return;
    let activeIndex = restored.tabs.findIndex(
      (tab) => tab.id === restored.activeTabId,
    );
    if (activeIndex < 0) activeIndex = 0;
    restored.tabs.forEach((tab, index) => {
      const created = this.createTab(
        windowId,
        tab.kind,
        index === 0 && urlOverride
          ? urlOverride
          : tab.url || 'https://example.com',
        tab.workingDirectory,
      );
      if (tab.kind === 'browser') {
        this.patchTab(created.id, { title: tab.title || 'Restored tab' });
      }
      if (tab.kind === 'terminal' && tab.workingDirectory) {
        this.patchTab(created.id, {
          workingDirectory: tab.workingDirectory,
        });
      }
    });
    const active = window.tabs[activeIndex];
    if (active) this.activateTab(windowId, active.id);
  }

  snapshot(windowId?: string): WorkspaceSnapshot {
    return {
      windows: [...this.windows.values()]
        .filter((entry) => !windowId || entry.id === windowId)
        .map((entry) => ({
          id: entry.id,
          activeTabId: entry.activeTabId,
          tabs: entry.tabs.map((tab) => ({ ...tab })),
        })),
    };
  }

  createTab(
    windowId: string,
    kind: 'browser' | 'terminal',
    url = 'https://example.com',
    cwd = homedir(),
  ): Tab {
    const window = this.requireWindow(windowId);
    const tab: Tab = {
      id: randomUUID(),
      kind,
      title: kind === 'browser' ? 'New tab' : 'Terminal',
      ...(kind === 'browser' ? { url } : { workingDirectory: cwd }),
    };
    window.tabs.push(tab);
    if (kind === 'browser') {
      this.browser.create(tab.id, windowId, window.browserWindow, url);
    } else {
      this.terminal.create(tab.id, cwd);
    }
    this.activateTab(windowId, tab.id);
    this.emit();
    return tab;
  }

  activateTab(windowId: string, tabId: string): void {
    const window = this.requireWindow(windowId);
    const tab = window.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error(`Tab ${tabId} is not in window ${windowId}`);
    window.activeTabId = tabId;
    if (tab.kind === 'browser') {
      this.browser.activate(tabId, window.browserWindow);
    } else {
      this.browser.hide(windowId, window.browserWindow);
    }
    this.emit();
  }

  closeTab(windowId: string, tabId: string): void {
    const window = this.requireWindow(windowId);
    const tab = window.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error(`Tab ${tabId} is not in window ${windowId}`);
    if (tab.kind === 'browser') this.browser.close(tabId, window.browserWindow);
    else this.terminal.close(tabId);
    window.tabs = window.tabs.filter((candidate) => candidate.id !== tabId);
    if (window.activeTabId === tabId) {
      const next = window.tabs.at(-1);
      window.activeTabId = next?.id ?? null;
      if (next) this.activateTab(windowId, next.id);
      else this.browser.hide(windowId, window.browserWindow);
    }
    this.emit();
  }

  closeWindow(windowId: string): void {
    const window = this.windows.get(windowId);
    if (!window) return;
    for (const tab of window.tabs) {
      if (tab.kind === 'browser')
        this.browser.close(tab.id, window.browserWindow);
      else this.terminal.close(tab.id);
    }
    this.windows.delete(windowId);
    this.emit();
  }

  terminalInput(value: unknown): void {
    this.terminal.input(value);
  }

  terminalResize(value: unknown): void {
    this.terminal.resize(value);
  }

  terminalBuffer(tabId: string): { data: string; revision: number } {
    return this.terminal.buffer(tabId);
  }

  assertTabInWindow(windowId: string, tabId: string): void {
    const window = this.requireWindow(windowId);
    if (!window.tabs.some((tab) => tab.id === tabId)) {
      throw new Error(`Tab ${tabId} is not owned by window ${windowId}`);
    }
  }

  acknowledgeTerminal(tabId: string): void {
    this.terminal.acknowledge(tabId);
  }

  openWindow(browserWindow: BrowserWindow): string {
    return this.addWindow(browserWindow).id;
  }

  dispose(): void {
    this.browser.dispose();
    this.terminal.dispose();
  }

  private patchTab(tabId: string, patch: Partial<Tab>): void {
    const owner = [...this.windows.values()].find((window) =>
      window.tabs.some((tab) => tab.id === tabId),
    );
    const tab = owner?.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    Object.assign(tab, patch);
    this.emit();
  }

  private rendererForTab(tabId: string): BrowserWindow | undefined {
    return [...this.windows.values()].find((window) =>
      window.tabs.some((tab) => tab.id === tabId),
    )?.browserWindow;
  }

  private requireWindow(windowId: string): InternalWindow {
    const window = this.windows.get(windowId);
    if (!window) throw new Error(`Window ${windowId} does not exist`);
    return window;
  }

  private emit(): void {
    for (const window of this.windows.values()) {
      window.browserWindow.webContents.send(
        'workspace:changed',
        this.snapshot(window.id),
      );
    }
    this.changed();
  }
}
