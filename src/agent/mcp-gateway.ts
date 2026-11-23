import { app } from 'electron';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from '@modelcontextprotocol/node';
import { z } from 'zod';
import type { BrowserController } from '../browser/browser-controller';
import {
  browserNavigateSchema,
  browserScrollSchema,
  browserTextInputSchema,
  browserWaitSchema,
  locatorSchema,
  safeUrl,
  type McpConnection,
  type WorkspaceSnapshot,
} from '../shared/protocol';

type GatewayOptions = {
  browser: BrowserController;
  snapshot(): WorkspaceSnapshot;
  openBrowser(url: string): string;
  audit(entry: Record<string, unknown>): void;
};

function toolResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    structuredContent:
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)
        : { value },
  };
}

function tokenMatches(expected: string, candidate: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const candidateBytes = Buffer.from(candidate);
  return (
    expectedBytes.length === candidateBytes.length &&
    timingSafeEqual(expectedBytes, candidateBytes)
  );
}

async function withShutdownTimeout(
  operation: Promise<unknown>,
  timeoutMs = 2_000,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    operation,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref();
    }),
  ]);
  if (timer) clearTimeout(timer);
}

function redactForAudit(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForAudit);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (
        /^(text|body|token|authorization|password|secret|cookie)$/i.test(key)
      ) {
        return [key, '[redacted]'];
      }
      if (/url/i.test(key) && typeof entry === 'string') {
        try {
          const url = new URL(entry);
          url.search = '';
          url.hash = '';
          return [key, url.href];
        } catch {
          return [key, '[invalid-url]'];
        }
      }
      return [key, redactForAudit(entry)];
    }),
  );
}

export class McpGateway {
  private httpServer: HttpServer | null = null;
  private mcpServer: McpServer | null = null;
  private transport: NodeStreamableHTTPServerTransport | null = null;
  private token: string | null = null;
  private url: string | null = null;
  private activeRequests = 0;

  constructor(private readonly options: GatewayOptions) {}

  async enable(): Promise<McpConnection> {
    if (this.httpServer) return this.status();
    this.token = await this.loadOrCreateToken();
    const server = new McpServer({
      name: 'surfboard',
      version: app.getVersion(),
    });
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      maxRequestBodySize: 1_000_000,
    });
    this.registerTools(server);
    await server.connect(transport);

    const validHost = localhostHostValidation();
    const validOrigin = localhostOriginValidation();
    const httpServer = createServer(async (request, response) => {
      if (!validHost(request, response) || !validOrigin(request, response)) {
        return;
      }
      const authorization = request.headers.authorization;
      if (
        !authorization?.startsWith('Bearer ') ||
        !this.token ||
        !tokenMatches(this.token, authorization.slice('Bearer '.length))
      ) {
        response.writeHead(401, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
        });
        response.end(JSON.stringify({ error: 'invalid agent capability' }));
        return;
      }

      this.activeRequests += 1;
      try {
        await transport.handleRequest(request, response);
      } catch (error) {
        this.options.audit({
          type: 'mcp.error',
          message: error instanceof Error ? error.message : String(error),
        });
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json' });
        }
        response.end(JSON.stringify({ error: 'MCP request failed' }));
      } finally {
        this.activeRequests -= 1;
      }
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', () => {
        httpServer.off('error', reject);
        resolve();
      });
    });
    const address = httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('MCP server did not bind to a TCP port');
    }
    this.httpServer = httpServer;
    this.mcpServer = server;
    this.transport = transport;
    this.url = `http://127.0.0.1:${address.port}/mcp`;
    this.options.audit({ type: 'mcp.enabled', url: this.url });
    return this.status();
  }

  async disable(): Promise<McpConnection> {
    if (!this.httpServer) return this.status();
    const httpServer = this.httpServer;
    const server = this.mcpServer;
    const transport = this.transport;
    this.httpServer = null;
    this.mcpServer = null;
    this.transport = null;
    this.url = null;
    const transportClosed = transport?.close() ?? Promise.resolve();
    await withShutdownTimeout(transportClosed);
    const httpClosed = new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
    httpServer.closeAllConnections();
    await withShutdownTimeout(httpClosed);
    await withShutdownTimeout(server?.close() ?? Promise.resolve());
    this.options.audit({ type: 'mcp.disabled' });
    return this.status();
  }

  status(): McpConnection {
    return {
      enabled: this.httpServer !== null,
      url: this.url,
      token: this.token,
      activeRequests: this.activeRequests,
    };
  }

  async dispose(): Promise<void> {
    await this.disable();
  }

  private async loadOrCreateToken(): Promise<string> {
    const tokenPath = path.join(
      app.getPath('userData'),
      'agent-capability-token',
    );
    try {
      const token = (await readFile(tokenPath, 'utf8')).trim();
      if (token.length >= 32) return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const token = randomBytes(32).toString('base64url');
    await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
    await chmod(tokenPath, 0o600);
    return token;
  }

  private registerTools(server: McpServer): void {
    const browser = this.options.browser;
    const run = async (
      name: string,
      details: unknown,
      action: () => unknown,
    ) => {
      this.options.audit({
        type: 'mcp.tool',
        name,
        details: redactForAudit(details),
      });
      return toolResult(await action());
    };

    server.registerTool(
      'surfboard_list_tabs',
      {
        title: 'List Surfboard tabs',
        description: 'List browser and terminal tabs in Surfboard windows.',
        inputSchema: z.object({}),
      },
      async () => run('surfboard_list_tabs', {}, () => this.options.snapshot()),
    );

    server.registerTool(
      'surfboard_open_browser',
      {
        title: 'Open browser tab',
        description: 'Open an HTTP(S) page in a Surfboard browser tab.',
        inputSchema: z.object({ url: z.string().url() }),
      },
      async ({ url }) => {
        const parsed = safeUrl(url);
        if (!parsed) throw new Error('Only HTTP(S) URLs are allowed');
        return run('surfboard_open_browser', { url: parsed.href }, () => ({
          tabId: this.options.openBrowser(parsed.href),
        }));
      },
    );

    server.registerTool(
      'surfboard_get_page',
      {
        title: 'Inspect active page',
        description: 'Return page metadata, text, and an accessibility tree.',
        inputSchema: z.object({ tabId: z.string().uuid().optional() }),
      },
      async ({ tabId }) =>
        run('surfboard_get_page', { tabId }, () => browser.getPage(tabId)),
    );

    server.registerTool(
      'surfboard_capture_page',
      {
        title: 'Capture active page',
        description: 'Capture a PNG screenshot of the active browser viewport.',
        inputSchema: z.object({ tabId: z.string().uuid().optional() }),
      },
      async ({ tabId }) =>
        run('surfboard_capture_page', { tabId }, () => browser.capture(tabId)),
    );

    server.registerTool(
      'surfboard_navigate',
      {
        title: 'Navigate browser tab',
        description: 'Navigate a browser tab to an HTTP(S) URL.',
        inputSchema: browserNavigateSchema,
      },
      async (input) =>
        run('surfboard_navigate', input, () => {
          browser.navigate(input);
          return { accepted: true, tabId: input.tabId, url: input.url };
        }),
    );

    server.registerTool(
      'surfboard_click',
      {
        title: 'Click page element',
        description:
          'Click the center of an element matched by a CSS selector.',
        inputSchema: locatorSchema,
      },
      async (input) =>
        run('surfboard_click', input, () => browser.click(input)),
    );

    server.registerTool(
      'surfboard_type',
      {
        title: 'Type into page element',
        description: 'Focus a CSS selector and insert text.',
        inputSchema: browserTextInputSchema,
      },
      async (input) => run('surfboard_type', input, () => browser.type(input)),
    );

    server.registerTool(
      'surfboard_scroll',
      {
        title: 'Scroll page',
        description: 'Scroll the active document by a bounded pixel amount.',
        inputSchema: browserScrollSchema,
      },
      async (input) =>
        run('surfboard_scroll', input, () => browser.scroll(input)),
    );

    server.registerTool(
      'surfboard_wait_for',
      {
        title: 'Wait for page selector',
        description: 'Wait until a CSS selector exists or the timeout elapses.',
        inputSchema: browserWaitSchema,
      },
      async (input) =>
        run('surfboard_wait_for', input, () => browser.waitFor(input)),
    );

    server.registerTool(
      'surfboard_get_console',
      {
        title: 'Read browser console',
        description: 'Return recent console and runtime exception events.',
        inputSchema: z.object({ tabId: z.string().uuid().optional() }),
      },
      async ({ tabId }) =>
        run('surfboard_get_console', { tabId }, () => ({
          events: browser.getConsole(tabId),
        })),
    );

    server.registerTool(
      'surfboard_get_network',
      {
        title: 'Read browser network activity',
        description: 'Return recent request metadata; bodies are not included.',
        inputSchema: z.object({ tabId: z.string().uuid().optional() }),
      },
      async ({ tabId }) =>
        run('surfboard_get_network', { tabId }, () => ({
          events: browser.getNetwork(tabId),
        })),
    );
  }
}
