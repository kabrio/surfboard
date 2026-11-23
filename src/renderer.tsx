import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import './index.css';
import type { McpConnection, Tab, WorkspaceSnapshot } from './shared/protocol';

function formatTitle(tab: Tab): string {
  if (tab.title.trim()) return tab.title.trim();
  return tab.kind === 'browser' ? 'New browser tab' : 'Terminal';
}

function IconButton({
  label,
  children,
  disabled,
  onClick,
}: {
  label: string;
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function TerminalPane({ tab }: { tab: Tab }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!host.current) return;
    const terminal = new Terminal({
      allowProposedApi: true,
      convertEol: true,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: 13,
      scrollback: 10_000,
      smoothScrollDuration: 40,
      theme: {
        background: '#0c0c0c',
        foreground: '#d8d8d8',
        cursor: '#f4f4f2',
        selectionBackground: '#3a3a3a',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(
      new WebLinksAddon((_event, url) => {
        void window.surfboard
          .createTab('browser')
          .then((id) => window.surfboard.navigate(id, url));
      }),
    );
    terminal.open(host.current);
    fit.fit();

    const input = terminal.onData((data) => {
      void window.surfboard.terminalInput({ tabId: tab.id, data });
    });
    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      void window.surfboard.terminalResize(
        tab.id,
        terminal.cols,
        terminal.rows,
      );
    });
    resizeObserver.observe(host.current);
    let lastRevision = -1;
    let ready = false;
    const pending: Array<{ data: string; revision: number }> = [];
    const dataSubscription = window.surfboard.onTerminalData((event) => {
      if (event.tabId !== tab.id) return;
      if (!ready) {
        pending.push(event);
        return;
      }
      if (event.revision <= lastRevision) {
        void window.surfboard.acknowledgeTerminal(tab.id);
        return;
      }
      lastRevision = event.revision;
      terminal.write(event.data, () => {
        void window.surfboard.acknowledgeTerminal(tab.id);
      });
    });
    void window.surfboard
      .getTerminalBuffer(tab.id)
      .then((buffer) => {
        terminal.write(buffer.data);
        lastRevision = buffer.revision;
        ready = true;
        for (const event of pending) {
          if (event.revision > lastRevision) {
            lastRevision = event.revision;
            terminal.write(event.data, () => {
              void window.surfboard.acknowledgeTerminal(tab.id);
            });
          } else {
            void window.surfboard.acknowledgeTerminal(tab.id);
          }
        }
        terminal.scrollToBottom();
      })
      .catch((error) => console.error('Unable to load terminal buffer', error));
    void window.surfboard.terminalResize(tab.id, terminal.cols, terminal.rows);

    return () => {
      input.dispose();
      dataSubscription();
      resizeObserver.disconnect();
      terminal.dispose();
    };
  }, [tab.id]);

  return (
    <div className="terminal-pane">
      <div ref={host} className="terminal-host" />
      {tab.exited && <div className="terminal-exit">Shell exited</div>}
    </div>
  );
}

function BrowserPane({
  tab,
  navigate,
}: {
  tab: Tab;
  navigate: (url: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [address, setAddress] = useState(tab.url ?? '');

  useEffect(() => setAddress(tab.url ?? ''), [tab.url]);
  useEffect(() => {
    if (!host.current) return;
    const update = () => {
      if (!host.current) return;
      const rect = host.current.getBoundingClientRect();
      void window.surfboard.setBrowserBounds(tab.id, {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(host.current);
    update();
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [tab.id]);

  return (
    <div className="browser-pane">
      <div className="browser-toolbar">
        <IconButton
          label="Back"
          disabled={!tab.canGoBack}
          onClick={() => void window.surfboard.goBack(tab.id)}
        >
          ←
        </IconButton>
        <IconButton
          label="Forward"
          disabled={!tab.canGoForward}
          onClick={() => void window.surfboard.goForward(tab.id)}
        >
          →
        </IconButton>
        <IconButton
          label="Reload"
          onClick={() => void window.surfboard.reload(tab.id)}
        >
          ↻
        </IconButton>
        <form
          className="address-form"
          onSubmit={(event) => {
            event.preventDefault();
            navigate(address);
          }}
        >
          <span className={`load-dot ${tab.loading ? 'loading' : ''}`} />
          <input
            className="address-input"
            aria-label="Address"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            spellCheck={false}
          />
        </form>
        <IconButton
          label="Open DevTools"
          onClick={() => void window.surfboard.openDevTools(tab.id)}
        >
          ⌘
        </IconButton>
      </div>
      <div ref={host} className="browser-host" aria-label="Browser content" />
    </div>
  );
}

function AgentPanel() {
  const [status, setStatus] = useState<McpConnection>({
    enabled: false,
    url: null,
    token: null,
    activeRequests: 0,
  });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void window.surfboard.getAgentStatus().then(setStatus);
  }, []);

  const config = useMemo(
    () =>
      status.url && status.token
        ? JSON.stringify(
            {
              mcpServers: {
                surfboard: {
                  type: 'http',
                  url: status.url,
                  headers: { Authorization: `Bearer ${status.token}` },
                },
              },
            },
            null,
            2,
          )
        : '',
    [status],
  );

  return (
    <section className="agent-panel" aria-label="Agent access">
      <div className="agent-copy">
        <span
          className={`status-light ${status.enabled ? 'connected' : ''}`}
          aria-hidden
        />
        <div>
          <strong>Agent access</strong>
          <small>
            {status.enabled
              ? `Local MCP enabled · ${status.activeRequests} active`
              : 'Off · remote pages and terminal processes stay private'}
          </small>
        </div>
      </div>
      <button
        type="button"
        className="secondary-button"
        onClick={() =>
          void window.surfboard.setAgentEnabled(!status.enabled).then(setStatus)
        }
      >
        {status.enabled ? 'Disable' : 'Enable'}
      </button>
      {status.enabled && (
        <>
          <code className="mcp-url">{status.url}</code>
          <button
            type="button"
            className="secondary-button"
            disabled={!config}
            onClick={() => {
              void navigator.clipboard.writeText(config).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1800);
              });
            }}
          >
            {copied ? 'Copied' : 'Copy MCP config'}
          </button>
        </>
      )}
    </section>
  );
}

function App() {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);

  useEffect(() => {
    void window.surfboard.getWorkspace().then(setWorkspace);
    return window.surfboard.onWorkspaceChanged(setWorkspace);
  }, []);

  const currentWindow = workspace?.windows[0];
  const activeTab = currentWindow?.tabs.find(
    (tab) => tab.id === currentWindow.activeTabId,
  );

  return (
    <main className="app-shell">
      <header className="titlebar">
        <div className="brand" aria-label="SURFBOARD">
          SURFBOARD
        </div>
        <div className="workspace-name">Local workspace</div>
        <button
          type="button"
          className="new-window-button"
          onClick={() => void window.surfboard.newWindow()}
        >
          New window
        </button>
      </header>

      <nav className="tabbar" aria-label="Workspace tabs">
        <div className="tabs">
          {currentWindow?.tabs.map((tab) => (
            <div
              className={`tab ${tab.id === currentWindow.activeTabId ? 'active' : ''}`}
              key={tab.id}
            >
              <button
                type="button"
                className="tab-select"
                onClick={() => void window.surfboard.activateTab(tab.id)}
              >
                <span className="tab-kind">
                  {tab.kind === 'browser' ? '◎' : '>_'}
                </span>
                <span className="tab-title">{formatTitle(tab)}</span>
              </button>
              <button
                type="button"
                className="tab-close"
                aria-label={`Close ${formatTitle(tab)}`}
                onClick={() => void window.surfboard.closeTab(tab.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="tab-actions">
          <IconButton
            label="New browser tab"
            onClick={() => void window.surfboard.createTab('browser')}
          >
            ◎
          </IconButton>
          <IconButton
            label="New terminal tab"
            onClick={() => void window.surfboard.createTab('terminal')}
          >
            &gt;_
          </IconButton>
        </div>
      </nav>

      <section className="content">
        {!activeTab && (
          <div className="empty-state">
            <h1>Start a session</h1>
            <p>Create a Chromium browser tab or a native terminal tab.</p>
            <div className="empty-actions">
              <button
                type="button"
                onClick={() => void window.surfboard.createTab('browser')}
              >
                New browser
              </button>
              <button
                type="button"
                onClick={() => void window.surfboard.createTab('terminal')}
              >
                New terminal
              </button>
            </div>
          </div>
        )}
        {activeTab?.kind === 'browser' && (
          <BrowserPane
            tab={activeTab}
            navigate={(url) =>
              void window.surfboard.navigate(
                activeTab.id,
                /^https?:\/\//i.test(url) ? url : `https://${url}`,
              )
            }
          />
        )}
        {activeTab?.kind === 'terminal' && <TerminalPane tab={activeTab} />}
      </section>
      <AgentPanel />
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
