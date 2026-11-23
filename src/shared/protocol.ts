import { z } from 'zod';

export const tabKindSchema = z.enum(['browser', 'terminal']);
export type TabKind = z.infer<typeof tabKindSchema>;

export const tabSchema = z.object({
  id: z.string().uuid(),
  kind: tabKindSchema,
  title: z.string(),
  url: z.string().optional(),
  workingDirectory: z.string().optional(),
  loading: z.boolean().optional(),
  canGoBack: z.boolean().optional(),
  canGoForward: z.boolean().optional(),
  processId: z.number().int().positive().optional(),
  exited: z.boolean().optional(),
});
export type Tab = z.infer<typeof tabSchema>;

export const workspaceWindowSchema = z.object({
  id: z.string().uuid(),
  activeTabId: z.string().uuid().nullable(),
  tabs: z.array(tabSchema),
});
export type WorkspaceWindow = z.infer<typeof workspaceWindowSchema>;

export const workspaceSnapshotSchema = z.object({
  windows: z.array(workspaceWindowSchema),
});
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;

export const boundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative(),
});
export type Bounds = z.infer<typeof boundsSchema>;

export const terminalInputSchema = z.object({
  tabId: z.string().uuid(),
  data: z.string().max(1_000_000),
});
export type TerminalInput = z.infer<typeof terminalInputSchema>;

export const terminalSizeSchema = z.object({
  tabId: z.string().uuid(),
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(1).max(500),
});

export const mcpConnectionSchema = z.object({
  enabled: z.boolean(),
  url: z.string().nullable(),
  token: z.string().nullable(),
  activeRequests: z.number().int().nonnegative(),
});
export type McpConnection = z.infer<typeof mcpConnectionSchema>;

export const locatorSchema = z.object({
  tabId: z.string().uuid().optional(),
  selector: z.string().min(1).max(10_000),
});

export const browserNavigateSchema = z.object({
  tabId: z.string().uuid(),
  url: z.string().url().max(1_000_000),
});

export const browserTextInputSchema = locatorSchema.extend({
  text: z.string().max(1_000_000),
});

export const browserScrollSchema = z.object({
  tabId: z.string().uuid().optional(),
  x: z.number().finite().min(-10_000_000).max(10_000_000).default(0),
  y: z.number().finite().min(-10_000_000).max(10_000_000),
});

export const browserWaitSchema = z.object({
  tabId: z.string().uuid().optional(),
  condition: z.string().min(1).max(50_000),
  timeoutMs: z.number().int().min(50).max(60_000).default(10_000),
});

export function safeUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}
