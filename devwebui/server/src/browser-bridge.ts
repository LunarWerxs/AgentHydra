// Browser bridge: lets an agent ask the LIVE tabs of a supervised dev app what is going on in
// them (client-side runtime errors, page metadata, tools the page registered itself), without a
// headless browser. A dev page opts in by loading the daemon's client snippet
// (browser-client.ts), which holds an SSE connection to the daemon and answers requests over POST.
//
// The request map is the whole server half: one request id is fanned out to every matching tab,
// one answer is collected per tab, and the promise resolves as soon as every tab answered - or,
// when the timeout fires, with whatever came back. It rejects only if NO tab answered, so one
// frozen tab never hides the answers of the healthy ones. The fan-out/partial-timeout shape is
// the one Next.js's dev MCP uses (vercel/next.js, MIT); this is written fresh for DevWebUI.
import { randomUUID } from "node:crypto";

/** What an agent can ask a tab. `call` runs one page-registered tool. */
export type BridgeKind = "errors" | "metadata" | "tools" | "call";

/** The message pushed down a tab's SSE connection. */
export interface BridgeRequest {
  requestId: string;
  kind: BridgeKind;
  tool?: string;
  args?: unknown;
}

/** A connected tab, as listed to agents. */
export interface BrowserTab {
  tabId: string;
  url: string;
  title: string;
  connectedAt: number;
}

/** One tab's answer: a result, or the error the page reported. */
export interface TabAnswer {
  tabId: string;
  url: string;
  title: string;
  result?: unknown;
  error?: string;
}

export interface BridgeResult {
  /** Tabs the request was sent to. */
  expected: number;
  /** Tabs that answered before the timeout. */
  answered: number;
  /** True when the timeout fired before every tab answered (the answers are partial). */
  timedOut: boolean;
  tabs: TabAnswer[];
}

/** Which tabs a request goes to. Omitted fields match every tab. */
export interface TabFilter {
  tabId?: string;
  /** Match tabs whose page URL is on this port (a supervised process's declared port). */
  port?: number;
}

interface TabConn extends BrowserTab {
  send: (req: BridgeRequest) => Promise<void> | void;
}

interface Pending {
  tabIds: Set<string>;
  answers: Map<string, TabAnswer>;
  settle: (timedOut: boolean) => void;
}

export const DEFAULT_BRIDGE_TIMEOUT_MS = 5000;
const MAX_TABS = 32;

/** The effective port of a page URL (an implicit :80/:443 included), or null if unparseable. */
function urlPort(url: string): number | null {
  try {
    const u = new URL(url);
    if (u.port) return Number(u.port);
    return u.protocol === "https:" ? 443 : u.protocol === "http:" ? 80 : null;
  } catch {
    return null;
  }
}

export class BrowserBridge {
  private readonly tabs = new Map<string, TabConn>();
  private readonly pending = new Map<string, Pending>();

  /** Register a tab's connection; returns its id. The oldest tab is dropped past MAX_TABS so a
   *  page that reconnects in a loop cannot grow the map without bound. */
  connect(page: { url: string; title: string }, send: TabConn["send"]): string {
    if (this.tabs.size >= MAX_TABS) {
      const oldest = this.tabs.keys().next().value;
      if (oldest) this.disconnect(oldest);
    }
    const tabId = randomUUID();
    this.tabs.set(tabId, {
      tabId,
      url: page.url,
      title: page.title,
      connectedAt: Date.now(),
      send,
    });
    return tabId;
  }

  /** Forget a tab. Any request still waiting on it stops waiting, so a closed tab does not cost
   *  the caller the full timeout. */
  disconnect(tabId: string): void {
    if (!this.tabs.delete(tabId)) return;
    for (const p of this.pending.values()) {
      if (p.tabIds.delete(tabId) && p.answers.size >= p.tabIds.size) p.settle(false);
    }
  }

  listTabs(filter: TabFilter = {}): BrowserTab[] {
    return [...this.tabs.values()]
      .filter((t) => (filter.tabId ? t.tabId === filter.tabId : true))
      .filter((t) => (filter.port ? urlPort(t.url) === filter.port : true))
      .map(({ tabId, url, title, connectedAt }) => ({ tabId, url, title, connectedAt }));
  }

  /** Fan a request out to every matching tab. Resolves when all answered, or at the timeout
   *  with the partial set; rejects when no tab matches or none answered in time. */
  request(
    kind: BridgeKind,
    opts: { tool?: string; args?: unknown; filter?: TabFilter; timeoutMs?: number } = {},
  ): Promise<BridgeResult> {
    const targets = this.listTabs(opts.filter);
    if (targets.length === 0) {
      return Promise.reject(
        new Error(
          this.tabs.size === 0
            ? "no browser tab is connected - load the DevWebUI browser snippet in the page (see AI_GUIDE.md, 'Browser tabs')"
            : "no connected browser tab matches that filter - see list_browser_tabs",
        ),
      );
    }
    const requestId = randomUUID();
    const req: BridgeRequest = { requestId, kind, tool: opts.tool, args: opts.args };
    const timeoutMs = opts.timeoutMs ?? DEFAULT_BRIDGE_TIMEOUT_MS;
    return new Promise<BridgeResult>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const pending: Pending = {
        tabIds: new Set(targets.map((t) => t.tabId)),
        answers: new Map(),
        settle: (timedOut) => {
          clearTimeout(timer);
          this.pending.delete(requestId);
          const tabs = [...pending.answers.values()];
          if (tabs.length === 0) {
            reject(new Error(`no browser tab answered within ${timeoutMs} ms`));
            return;
          }
          resolve({ expected: targets.length, answered: tabs.length, timedOut, tabs });
        },
      };
      timer = setTimeout(() => pending.settle(true), timeoutMs);
      this.pending.set(requestId, pending);
      for (const t of targets) {
        // A dead connection is dropped, which also stops the request waiting on it.
        try {
          const sent = this.tabs.get(t.tabId)?.send(req);
          Promise.resolve(sent).catch(() => this.disconnect(t.tabId));
        } catch {
          this.disconnect(t.tabId);
        }
      }
    });
  }

  /** Record one tab's answer. The page reports its current URL/title with every answer (an SPA
   *  navigates without reconnecting), so the tab list follows it. Returns false for an unknown
   *  or already-settled request, or a tab it was not sent to. */
  reply(
    requestId: string,
    tabId: string,
    answer: { result?: unknown; error?: string; url?: string; title?: string },
  ): boolean {
    const p = this.pending.get(requestId);
    const tab = this.tabs.get(tabId);
    if (!p || !tab || !p.tabIds.has(tabId) || p.answers.has(tabId)) return false;
    if (typeof answer.url === "string") tab.url = answer.url;
    if (typeof answer.title === "string") tab.title = answer.title;
    p.answers.set(tabId, {
      tabId,
      url: tab.url,
      title: tab.title,
      ...(answer.error !== undefined ? { error: String(answer.error) } : { result: answer.result }),
    });
    if (p.answers.size >= p.tabIds.size) p.settle(false);
    return true;
  }
}
