import { contextBridge, ipcRenderer } from 'electron';
import type {
  Bounds,
  McpConnection,
  TabKind,
  TerminalInput,
  WorkspaceSnapshot,
} from './shared/protocol';

const surfboard = {
  getWorkspace: (): Promise<WorkspaceSnapshot> =>
    ipcRenderer.invoke('workspace:get'),
  onWorkspaceChanged: (listener: (workspace: WorkspaceSnapshot) => void) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      value: WorkspaceSnapshot,
    ) => listener(value);
    ipcRenderer.on('workspace:changed', wrapped);
    return () => {
      ipcRenderer.removeListener('workspace:changed', wrapped);
    };
  },
  createTab: (kind: TabKind): Promise<string> =>
    ipcRenderer.invoke('workspace:new-tab', kind),
  activateTab: (tabId: string): Promise<void> =>
    ipcRenderer.invoke('workspace:activate-tab', tabId),
  closeTab: (tabId: string): Promise<void> =>
    ipcRenderer.invoke('workspace:close-tab', tabId),
  navigate: (tabId: string, url: string): Promise<void> =>
    ipcRenderer.invoke('browser:navigate', { tabId, url }),
  setBrowserBounds: (tabId: string, bounds: Bounds): Promise<void> =>
    ipcRenderer.invoke('browser:set-bounds', { tabId, bounds }),
  goBack: (tabId: string): Promise<void> =>
    ipcRenderer.invoke('browser:back', tabId),
  goForward: (tabId: string): Promise<void> =>
    ipcRenderer.invoke('browser:forward', tabId),
  reload: (tabId: string): Promise<void> =>
    ipcRenderer.invoke('browser:reload', tabId),
  openDevTools: (tabId: string): Promise<void> =>
    ipcRenderer.invoke('browser:devtools', tabId),
  terminalInput: (input: TerminalInput): Promise<void> =>
    ipcRenderer.invoke('terminal:input', input),
  terminalResize: (tabId: string, cols: number, rows: number): Promise<void> =>
    ipcRenderer.invoke('terminal:resize', { tabId, cols, rows }),
  onTerminalData: (
    listener: (event: {
      tabId: string;
      data: string;
      revision: number;
    }) => void,
  ) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      value: {
        type: 'data';
        tabId: string;
        data: string;
        revision: number;
      },
    ) => listener(value);
    ipcRenderer.on('terminal:data', wrapped);
    return () => {
      ipcRenderer.removeListener('terminal:data', wrapped);
    };
  },
  getTerminalBuffer: (
    tabId: string,
  ): Promise<{ data: string; revision: number }> =>
    ipcRenderer.invoke('terminal:get-buffer', tabId),
  acknowledgeTerminal: (tabId: string): Promise<void> =>
    ipcRenderer.invoke('terminal:ack', tabId),
  getAgentStatus: (): Promise<McpConnection> =>
    ipcRenderer.invoke('agent:status'),
  setAgentEnabled: (enabled: boolean): Promise<McpConnection> =>
    ipcRenderer.invoke('agent:set-enabled', enabled),
  newWindow: (): Promise<void> => ipcRenderer.invoke('app:new-window'),
};

contextBridge.exposeInMainWorld('surfboard', surfboard);

export type SurfboardApi = typeof surfboard;
