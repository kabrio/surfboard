import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  type IpcMainInvokeEvent,
} from 'electron';
import path from 'node:path';
import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import started from 'electron-squirrel-startup';
import { z } from 'zod';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { WorkspaceManager } from './workspace/workspace-manager';
import { McpGateway } from './agent/mcp-gateway';
import {
  boundsSchema,
  tabKindSchema,
  terminalInputSchema,
  terminalSizeSchema,
  workspaceSnapshotSchema,
  type WorkspaceWindow,
} from './shared/protocol';

if (started) app.quit();

const tabIdSchema = z.string().uuid();
const navigationSchema = z.object({
  tabId: tabIdSchema,
  url: z.string().url(),
});

let workspace: WorkspaceManager;
const windowById = new Map<string, BrowserWindow>();
const auditPath = path.join(app.getPath('userData'), 'agent-audit.ndjson');
const workspacePath = path.join(app.getPath('userData'), 'workspace.json');
let disposing = false;
let gateway: McpGateway;
let persistenceTimer: NodeJS.Timeout | null = null;
let selfTestServer: HttpServer | null = null;

async function audit(entry: Record<string, unknown>): Promise<void> {
  const record = { timestamp: new Date().toISOString(), ...entry };
  await appendFile(auditPath, `${JSON.stringify(record)}\n`, {
    mode: 0o600,
  }).catch((error) => console.error('Unable to write agent audit log', error));
}

function requireWindow(event: IpcMainInvokeEvent): {
  id: string;
  window: BrowserWindow;
} {
  const browserWindow = BrowserWindow.fromWebContents(event.sender);
  if (!browserWindow) throw new Error('Renderer window no longer exists');
  const id = workspace.windowIdFor(browserWindow);
  if (!id) throw new Error('Renderer window is not registered');
  return { id, window: browserWindow };
}

function createWindow(
  restored?: WorkspaceWindow,
  selfTestUrl?: string,
): BrowserWindow {
  const browserWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 840,
    minHeight: 560,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition:
      process.platform === 'darwin' ? { x: 16, y: 16 } : undefined,
    backgroundColor: '#111318',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  const windowId = workspace.openWindow(browserWindow);
  windowById.set(windowId, browserWindow);
  let closing = false;
  browserWindow.on('close', () => {
    if (closing || disposing) return;
    closing = true;
    workspace.closeWindow(windowId);
  });
  browserWindow.on('closed', () => {
    windowById.delete(windowId);
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void browserWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void browserWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }

  browserWindow.webContents.once('did-finish-load', () => {
    if (restored) {
      workspace.restoreWindow(windowId, restored, selfTestUrl);
    } else {
      workspace.initializeWindow(windowId, selfTestUrl);
    }
    if (selfTestUrl) void runSelfTest(windowId);
  });
  return browserWindow;
}

async function loadWorkspace(): Promise<WorkspaceWindow[]> {
  try {
    const parsed = workspaceSnapshotSchema.parse(
      JSON.parse(await readFile(workspacePath, 'utf8')),
    );
    return parsed.windows;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Unable to restore workspace', error);
    }
    return [];
  }
}

function schedulePersistence(): void {
  if (persistenceTimer) clearTimeout(persistenceTimer);
  persistenceTimer = setTimeout(() => {
    persistenceTimer = null;
    void persistWorkspace().catch((error) =>
      console.error('Unable to persist workspace', error),
    );
  }, 250);
}

async function persistWorkspace(): Promise<void> {
  const previous = await readFile(workspacePath, 'utf8').catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (previous !== null) {
    await writeFile(`${workspacePath}.bak`, previous, { mode: 0o600 });
  }
  const temporary = `${workspacePath}.tmp`;
  await writeFile(temporary, JSON.stringify(workspace.snapshot(), null, 2), {
    mode: 0o600,
  });
  await rename(temporary, workspacePath);
}

async function runSelfTest(windowId: string): Promise<void> {
  const timeout = setTimeout(() => {
    console.error('Surfboard self-test timed out');
    app.exit(1);
  }, 20_000);
  timeout.unref();

  try {
    let state = workspace.snapshot(windowId);
    for (let attempts = 0; attempts < 40; attempts += 1) {
      state = workspace.snapshot(windowId);
      const terminal = state.windows[0]?.tabs.find(
        (tab) => tab.kind === 'terminal',
      );
      const browser = state.windows[0]?.tabs.find(
        (tab) => tab.kind === 'browser',
      );
      if (!terminal?.processId || !browser || !browser.url) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      const page = await workspace.browserController().getPage(browser.id);
      const capture = await workspace.browserController().capture(browser.id);
      const click = await workspace.browserController().click({
        tabId: browser.id,
        selector: '#action',
      });
      const afterClick = await workspace
        .browserController()
        .getPage(browser.id);
      const connection = await gateway.enable();
      if (!connection.url || !connection.token) {
        throw new Error('MCP gateway did not publish connection details');
      }
      const client = new Client({
        name: 'surfboard-self-test',
        version: '0.1.0',
      });
      const transport = new StreamableHTTPClientTransport(
        new URL(connection.url),
        {
          requestInit: {
            headers: {
              Authorization: `Bearer ${connection.token}`,
            },
          },
        },
      );
      await client.connect(transport);
      const listedTools = await client.listTools();
      const mcpPage = await client.callTool({
        name: 'surfboard_get_page',
        arguments: { tabId: browser.id },
      });
      await client.close();
      await gateway.disable();
      const pageText = JSON.stringify(page);
      if (
        !pageText.includes('Surfboard packaged smoke test') ||
        typeof capture.data !== 'string' ||
        !String(capture.data).length ||
        click.selector !== '#action' ||
        !listedTools.tools.some((tool) => tool.name === 'surfboard_get_page') ||
        !JSON.stringify(mcpPage).includes('Surfboard packaged smoke test') ||
        !workspace.terminalBuffer(terminal.id).data.length ||
        !JSON.stringify(afterClick).includes('"clicked":"yes"')
      ) {
        throw new Error('Packaged browser smoke assertions failed');
      }
      clearTimeout(timeout);
      console.log(
        JSON.stringify({
          ok: true,
          terminalPid: terminal.processId,
          browserUrl: browser.url,
        }),
      );
      app.exit(0);
      return;
    }
    throw new Error('Packaged browser or terminal did not become ready');
  } catch (error) {
    clearTimeout(timeout);
    console.error('Surfboard self-test failed', error);
    app.exit(1);
  }
}

async function startSelfTestFixture(): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><title>Surfboard packaged smoke test</title>
      <button id="action">Act</button>
      <main>Surfboard packaged smoke test</main>
      <script>
        document.querySelector('#action').addEventListener('click', () => {
          document.body.dataset.clicked = 'yes';
        });
      </script>`);
  });
  selfTestServer = server;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Fixture server did not bind to TCP');
  }
  return `http://127.0.0.1:${address.port}/`;
}

function registerIpc(): void {
  ipcMain.handle('workspace:get', (event) => {
    const { id } = requireWindow(event);
    return workspace.snapshot(id);
  });
  ipcMain.handle('workspace:new-tab', (event, kind) => {
    const { id } = requireWindow(event);
    return workspace.createTab(id, tabKindSchema.parse(kind)).id;
  });
  ipcMain.handle('workspace:activate-tab', (event, tabId) => {
    const { id } = requireWindow(event);
    workspace.activateTab(id, tabIdSchema.parse(tabId));
  });
  ipcMain.handle('workspace:close-tab', (event, tabId) => {
    const { id } = requireWindow(event);
    workspace.closeTab(id, tabIdSchema.parse(tabId));
  });
  ipcMain.handle('browser:navigate', (event, input) => {
    const { id } = requireWindow(event);
    const parsed = navigationSchema.parse(input);
    workspace.assertTabInWindow(id, parsed.tabId);
    workspace.browserController().navigate(parsed);
  });
  ipcMain.handle('browser:set-bounds', (event, value) => {
    const { id } = requireWindow(event);
    const input = z
      .object({ tabId: tabIdSchema, bounds: boundsSchema })
      .parse(value);
    workspace.assertTabInWindow(id, input.tabId);
    workspace.browserController().setBounds(input.tabId, input.bounds);
  });
  for (const channel of ['back', 'forward', 'reload', 'devtools']) {
    ipcMain.handle(`browser:${channel}`, (event, tabId) => {
      const { id } = requireWindow(event);
      const parsed = tabIdSchema.parse(tabId);
      workspace.assertTabInWindow(id, parsed);
      if (channel === 'back') workspace.browserController().goBack(parsed);
      else if (channel === 'forward')
        workspace.browserController().goForward(parsed);
      else if (channel === 'reload')
        workspace.browserController().reload(parsed);
      else workspace.browserController().openDevTools(parsed);
    });
  }
  ipcMain.handle('terminal:input', (event, value) => {
    const { id } = requireWindow(event);
    const parsed = terminalInputSchema.parse(value);
    workspace.assertTabInWindow(id, parsed.tabId);
    workspace.terminalInput(parsed);
  });
  ipcMain.handle('terminal:resize', (event, value) => {
    const { id } = requireWindow(event);
    const parsed = terminalSizeSchema.parse(value);
    workspace.assertTabInWindow(id, parsed.tabId);
    workspace.terminalResize(parsed);
  });
  ipcMain.handle('terminal:get-buffer', (event, tabId) => {
    const { id } = requireWindow(event);
    const parsed = tabIdSchema.parse(tabId);
    workspace.assertTabInWindow(id, parsed);
    return workspace.terminalBuffer(parsed);
  });
  ipcMain.handle('terminal:ack', (event, tabId) => {
    const { id } = requireWindow(event);
    const parsed = tabIdSchema.parse(tabId);
    workspace.assertTabInWindow(id, parsed);
    workspace.acknowledgeTerminal(parsed);
  });
  ipcMain.handle('agent:status', () => gateway.status());
  ipcMain.handle('agent:set-enabled', async (_event, enabled) => {
    if (z.boolean().parse(enabled)) return gateway.enable();
    return gateway.disable();
  });
  ipcMain.handle('app:new-window', () => createWindow());
}

function installMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'SURFBOARD',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Browser Tab',
          accelerator: 'CommandOrControl+T',
          click: (_, window) => {
            if (!window) return;
            const browserWindow = BrowserWindow.fromId(window.id);
            if (!browserWindow) return;
            const id = workspace.windowIdFor(browserWindow);
            if (id) workspace.createTab(id, 'browser');
          },
        },
        {
          label: 'New Terminal Tab',
          accelerator: 'CommandOrControl+Shift+T',
          click: (_, window) => {
            if (!window) return;
            const browserWindow = BrowserWindow.fromId(window.id);
            if (!browserWindow) return;
            const id = workspace.windowIdFor(browserWindow);
            if (id) workspace.createTab(id, 'terminal');
          },
        },
        {
          label: 'New Window',
          accelerator: 'CommandOrControl+N',
          click: () => createWindow(),
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  workspace = new WorkspaceManager();
  workspace.onChanged(schedulePersistence);
  gateway = new McpGateway({
    browser: workspace.browserController(),
    snapshot: () => workspace.snapshot(),
    openBrowser: (url) => {
      const target =
        BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (!target) throw new Error('Open a Surfboard window first');
      const windowId = workspace.windowIdFor(target);
      if (!windowId) throw new Error('Surfboard window is not registered');
      return workspace.createTab(windowId, 'browser', url).id;
    },
    audit: (entry) => void audit(entry),
  });
  registerIpc();
  installMenu();
  if (process.argv.includes('--self-test')) {
    createWindow(undefined, await startSelfTestFixture());
    return;
  }
  const restored = await loadWorkspace();
  if (restored.length) {
    for (const window of restored) createWindow(window);
  } else {
    createWindow();
  }
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  if (disposing) return;
  event.preventDefault();
  disposing = true;
  if (persistenceTimer) clearTimeout(persistenceTimer);
  try {
    await persistWorkspace();
  } catch (error) {
    console.error('Unable to persist workspace during quit', error);
  }
  workspace?.dispose();
  selfTestServer?.close();
  await gateway?.dispose();
  app.quit();
});
