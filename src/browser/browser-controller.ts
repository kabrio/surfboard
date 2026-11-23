import { WebContentsView, BrowserWindow, type WebContents } from 'electron';
import {
  browserNavigateSchema,
  browserScrollSchema,
  browserTextInputSchema,
  browserWaitSchema,
  boundsSchema,
  locatorSchema,
  safeUrl,
  type Bounds,
  type Tab,
} from '../shared/protocol';

type NetworkEvent = {
  requestId: string;
  url: string;
  method: string;
  type?: string;
  status?: number;
  timestamp: number;
};

type ConsoleEvent = {
  level: string;
  text: string;
  timestamp: number;
};

type BrowserSession = {
  tabId: string;
  windowId: string;
  view: WebContentsView;
  window: BrowserWindow;
  network: NetworkEvent[];
  console: ConsoleEvent[];
  bounds: Bounds | null;
};

export interface BrowserControllerOptions {
  onTabUpdate(tabId: string, patch: Partial<Tab>): void;
  onOpenUrl(windowId: string, url: string): void;
}

function responseText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function commandResultRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('CDP returned an invalid result');
  }
  return value as Record<string, unknown>;
}

function evaluateValue(result: unknown): unknown {
  const command = commandResultRecord(result);
  const response = command.result;
  if (typeof response !== 'object' || response === null) return undefined;
  const remote = response as Record<string, unknown>;
  if (remote.exceptionDetails) {
    throw new Error(responseText(remote.exceptionDetails));
  }
  if ('value' in remote) return remote.value;
  return remote.description ?? undefined;
}

export class BrowserController {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly attachedView = new Map<string, WebContentsView>();

  constructor(private readonly options: BrowserControllerOptions) {}

  create(
    tabId: string,
    windowId: string,
    window: BrowserWindow,
    url: string,
  ): void {
    if (this.sessions.has(tabId))
      throw new Error(`Browser tab ${tabId} exists`);
    const view = new WebContentsView({
      webPreferences: {
        partition: 'persist:surfboard',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    const session: BrowserSession = {
      tabId,
      windowId,
      view,
      window,
      network: [],
      console: [],
      bounds: null,
    };
    this.sessions.set(tabId, session);
    this.configureWebContents(tabId, view.webContents);
    void this.attachProtocol(session).catch((error) => {
      console.error('Unable to attach browser debugger', error);
      this.options.onTabUpdate(tabId, {
        title: 'Browser debugging unavailable',
      });
    });
    this.activate(tabId, window);
    this.navigate({ tabId, url });
  }

  private configureWebContents(tabId: string, contents: WebContents): void {
    contents.setWindowOpenHandler(({ url }) => {
      const session = this.sessions.get(tabId);
      if (session && safeUrl(url)) {
        this.options.onOpenUrl(session.windowId, url);
      }
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (!safeUrl(url)) {
        event.preventDefault();
        console.error(`Blocked browser navigation to ${url}`);
      }
    });
    contents.on('will-redirect', (event, url) => {
      if (!safeUrl(url)) {
        event.preventDefault();
        console.error(`Blocked browser redirect to ${url}`);
      }
    });
    contents.on('page-title-updated', (_event, title) => {
      this.options.onTabUpdate(tabId, { title });
    });
    contents.on('did-start-loading', () => {
      this.options.onTabUpdate(tabId, { loading: true });
    });
    contents.on('did-stop-loading', () => {
      this.options.onTabUpdate(tabId, {
        loading: false,
        url: contents.getURL(),
        canGoBack: contents.navigationHistory.canGoBack(),
        canGoForward: contents.navigationHistory.canGoForward(),
      });
    });
    contents.on('did-finish-load', () => {
      this.options.onTabUpdate(tabId, {
        title: contents.getTitle(),
        url: contents.getURL(),
        loading: false,
      });
    });
    contents.on(
      'did-fail-load',
      (_event, code, description, url, mainFrame) => {
        if (mainFrame && code !== -3) {
          this.options.onTabUpdate(tabId, {
            title: 'Page failed to load',
            loading: false,
            url,
          });
          console.error('Browser navigation failed', {
            code,
            description,
            url,
          });
        }
      },
    );
  }

  private async attachProtocol(session: BrowserSession): Promise<void> {
    const debuggerSession = session.view.webContents.debugger;
    if (debuggerSession.isAttached()) debuggerSession.detach();
    debuggerSession.attach('1.3');
    await Promise.all([
      debuggerSession.sendCommand('Page.enable'),
      debuggerSession.sendCommand('Runtime.enable'),
      debuggerSession.sendCommand('Network.enable', {
        maxTotalBufferSize: 2_000_000,
        maxResourceBufferSize: 500_000,
      }),
      debuggerSession.sendCommand('DOM.enable'),
      debuggerSession.sendCommand('Accessibility.enable'),
    ]);
    debuggerSession.on('message', (_event, method, params) => {
      const record = commandResultRecord(params);
      if (method === 'Network.requestWillBeSent') {
        const request = commandResultRecord(record.request);
        session.network.push({
          requestId: String(record.requestId),
          url: String(request.url).slice(0, 4_096),
          method: String(request.method),
          type: record.type ? String(record.type) : undefined,
          timestamp: Date.now(),
        });
        session.network.splice(0, Math.max(0, session.network.length - 250));
      } else if (method === 'Network.responseReceived') {
        const existing = session.network.find(
          (entry) => entry.requestId === String(record.requestId),
        );
        const response = commandResultRecord(record.response);
        if (existing && typeof response.status === 'number') {
          existing.status = response.status;
        }
      } else if (method === 'Runtime.consoleAPICalled') {
        const args = Array.isArray(record.args) ? record.args : [];
        session.console.push({
          level: String(record.type),
          text: args
            .map((item) =>
              responseText(
                typeof item === 'object' && item !== null
                  ? ((item as Record<string, unknown>).value ??
                      (item as Record<string, unknown>).description)
                  : item,
              ),
            )
            .join(' ')
            .slice(0, 8_192),
          timestamp: Date.now(),
        });
        session.console.splice(0, Math.max(0, session.console.length - 250));
      } else if (method === 'Runtime.exceptionThrown') {
        session.console.push({
          level: 'exception',
          text: responseText(record.exceptionDetails).slice(0, 8_192),
          timestamp: Date.now(),
        });
      }
    });
  }

  activate(tabId: string, window: BrowserWindow): void {
    const session = this.require(tabId);
    const existing = this.attachedView.get(session.windowId);
    if (existing && existing !== session.view) {
      window.contentView.removeChildView(existing);
      this.attachedView.delete(session.windowId);
    }
    if (existing !== session.view) {
      window.contentView.addChildView(session.view);
      this.attachedView.set(session.windowId, session.view);
    }
    if (session.bounds) session.view.setBounds(session.bounds);
  }

  hide(windowId: string, window: BrowserWindow): void {
    const existing = this.attachedView.get(windowId);
    if (!existing) return;
    window.contentView.removeChildView(existing);
    this.attachedView.delete(windowId);
  }

  setBounds(tabId: string, value: unknown): void {
    const bounds = boundsSchema.parse(value);
    const session = this.require(tabId);
    session.bounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    };
    if (
      !session.window.isDestroyed() &&
      this.attachedView.get(session.windowId) === session.view
    ) {
      session.view.setBounds(session.bounds);
    }
  }

  navigate(value: unknown): void {
    const input = browserNavigateSchema.parse(value);
    const session = this.require(input.tabId);
    const url = safeUrl(input.url);
    if (!url) throw new Error('Only HTTP and HTTPS URLs are allowed');
    void session.view.webContents.loadURL(url.href);
  }

  goBack(tabId: string): void {
    const contents = this.require(tabId).view.webContents;
    if (contents.navigationHistory.canGoBack()) {
      contents.navigationHistory.goBack();
    }
  }

  goForward(tabId: string): void {
    const contents = this.require(tabId).view.webContents;
    if (contents.navigationHistory.canGoForward()) {
      contents.navigationHistory.goForward();
    }
  }

  reload(tabId: string): void {
    this.require(tabId).view.webContents.reload();
  }

  openDevTools(tabId: string): void {
    const contents = this.require(tabId).view.webContents;
    contents.openDevTools({ mode: 'detach' });
  }

  close(tabId: string, window: BrowserWindow): void {
    const session = this.sessions.get(tabId);
    if (!session) return;
    if (this.attachedView.get(session.windowId) === session.view) {
      window.contentView.removeChildView(session.view);
      this.attachedView.delete(session.windowId);
    }
    if (session.view.webContents.debugger.isAttached()) {
      session.view.webContents.debugger.detach();
    }
    session.view.webContents.close();
    this.sessions.delete(tabId);
  }

  list(windowId?: string): Array<Tab & { windowId: string }> {
    return [...this.sessions.values()]
      .filter((session) => !windowId || session.windowId === windowId)
      .map((session) => ({
        id: session.tabId,
        kind: 'browser' as const,
        windowId: session.windowId,
        title: session.view.webContents.getTitle(),
        url: session.view.webContents.getURL(),
        loading: session.view.webContents.isLoadingMainFrame(),
        canGoBack: session.view.webContents.navigationHistory.canGoBack(),
        canGoForward: session.view.webContents.navigationHistory.canGoForward(),
      }));
  }

  resolve(tabId?: string): BrowserSession {
    if (tabId) return this.require(tabId);
    const focusedWindowId = BrowserWindow.getFocusedWindow()?.id;
    const candidates = [...this.sessions.values()].filter(
      (session) => this.attachedView.get(session.windowId) === session.view,
    );
    const session =
      candidates.find((candidate) => candidate.window.id === focusedWindowId) ??
      candidates.at(0);
    if (!session) throw new Error('No active browser tab is available');
    return session;
  }

  async getPage(tabId?: string): Promise<Record<string, unknown>> {
    const session = this.resolve(tabId);
    const debuggerSession = session.view.webContents.debugger;
    const page = evaluateValue(
      await debuggerSession.sendCommand('Runtime.evaluate', {
        expression: `(() => ({
          url: location.href,
          title: document.title,
          text: document.body?.innerText?.slice(0, 100000) ?? '',
          htmlLength: document.documentElement?.outerHTML?.length ?? 0,
          selectedText: getSelection()?.toString()?.slice(0, 10000) ?? '',
          clicked: document.body?.dataset?.clicked ?? null
        }))()`,
        returnByValue: true,
      }),
    );
    const accessibility = commandResultRecord(
      await debuggerSession.sendCommand('Accessibility.getFullAXTree'),
    );
    const nodes = Array.isArray(accessibility.nodes)
      ? accessibility.nodes.slice(0, 5_000)
      : accessibility.nodes;
    return {
      page,
      accessibility: {
        ...accessibility,
        nodes,
        truncated:
          Array.isArray(accessibility.nodes) &&
          accessibility.nodes.length > 5_000,
      },
    };
  }

  async capture(tabId?: string): Promise<Record<string, unknown>> {
    const session = this.resolve(tabId);
    const result = commandResultRecord(
      await session.view.webContents.debugger.sendCommand(
        'Page.captureScreenshot',
        { format: 'png', fromSurface: true, captureBeyondViewport: false },
      ),
    );
    return {
      mediaType: 'image/png',
      data: String(result.data),
      viewport: await session.view.webContents.executeJavaScript(
        '({ width: innerWidth, height: innerHeight, devicePixelRatio })',
      ),
    };
  }

  async click(value: unknown): Promise<Record<string, unknown>> {
    const input = locatorSchema.parse(value);
    const session = this.resolve(input.tabId);
    const debuggerSession = session.view.webContents.debugger;
    const document = commandResultRecord(
      await debuggerSession.sendCommand('DOM.getDocument', { depth: 1 }),
    );
    const root = commandResultRecord(document.root);
    const selected = commandResultRecord(
      await debuggerSession.sendCommand('DOM.querySelector', {
        nodeId: Number(root.nodeId),
        selector: input.selector,
      }),
    );
    if (Number(selected.nodeId) === 0) {
      throw new Error(`No element matches ${input.selector}`);
    }
    const box = commandResultRecord(
      await debuggerSession.sendCommand('DOM.getBoxModel', {
        nodeId: Number(selected.nodeId),
      }),
    );
    const model = commandResultRecord(box.model);
    if (!Array.isArray(model.content) || model.content.length < 2) {
      throw new Error(`Element has no clickable box: ${input.selector}`);
    }
    const [x1, y1, , , x3, y3] = model.content as number[];
    const x = (x1 + x3) / 2;
    const y = (y1 + y3) / 2;
    await debuggerSession.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await debuggerSession.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    return { selector: input.selector, x, y };
  }

  async type(value: unknown): Promise<Record<string, unknown>> {
    const input = browserTextInputSchema.parse(value);
    const session = this.resolve(input.tabId);
    const focused = evaluateValue(
      await session.view.webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: `(() => {
          const node = document.querySelector(${JSON.stringify(input.selector)});
          if (!node) return false;
          node.focus();
          return document.activeElement === node;
        })()`,
        returnByValue: true,
      }),
    );
    if (focused !== true) {
      throw new Error(`No focusable element matches ${input.selector}`);
    }
    await session.view.webContents.debugger.sendCommand('Input.insertText', {
      text: input.text,
    });
    return { selector: input.selector, characters: [...input.text].length };
  }

  async scroll(value: unknown): Promise<Record<string, unknown>> {
    const input = browserScrollSchema.parse(value);
    const session = this.resolve(input.tabId);
    evaluateValue(
      await session.view.webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: `window.scrollBy(${input.x}, ${input.y})`,
        returnByValue: true,
      }),
    );
    return { x: input.x, y: input.y };
  }

  async waitFor(value: unknown): Promise<Record<string, unknown>> {
    const input = browserWaitSchema.parse(value);
    const session = this.resolve(input.tabId);
    const valueResult = evaluateValue(
      await session.view.webContents.debugger.sendCommand('Runtime.evaluate', {
        expression: `new Promise((resolve) => {
          const selector = ${JSON.stringify(input.condition)};
          const started = performance.now();
          const check = () => {
            if (document.querySelector(selector)) {
              resolve({ matched: true });
            } else if (performance.now() - started >= ${input.timeoutMs}) {
              resolve({ matched: false });
            } else {
              requestAnimationFrame(check);
            }
          };
          check();
        })`,
        awaitPromise: true,
        returnByValue: true,
      }),
    );
    return commandResultRecord(valueResult);
  }

  getConsole(tabId?: string): ConsoleEvent[] {
    return [...this.resolve(tabId).console];
  }

  getNetwork(tabId?: string): NetworkEvent[] {
    return [...this.resolve(tabId).network];
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      if (
        !session.view.webContents.isDestroyed() &&
        session.view.webContents.debugger.isAttached()
      ) {
        session.view.webContents.debugger.detach();
      }
      if (!session.view.webContents.isDestroyed()) {
        session.view.webContents.close();
      }
    }
    this.sessions.clear();
    this.attachedView.clear();
  }

  private require(tabId: string): BrowserSession {
    const session = this.sessions.get(tabId);
    if (!session) throw new Error(`Browser tab ${tabId} does not exist`);
    return session;
  }
}
