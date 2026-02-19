import * as vscode from "vscode";
import * as crypto from "crypto";
import { AssertPrompt, AssertDecision } from "./assertPrompt";

export type AssertRecommendation = { action: string; reason: string; input?: string } | null;

export type AssertLocation = { path: string; line: number };

export type AssertTraceEntry = {
  id: number;
  key: string;
  time: number;
  type: "read" | "write";
  addr: number;
  size: number;
  pc: number;
  register?: string;
  peripheral?: string;
  reset?: string;
  value?: string;
  fields?: string;
  hints: string[];
  decisions: AssertDecision[];
  recommendation: AssertRecommendation;
  response?: string;
  responseAt?: number;
  location?: AssertLocation;
  registers?: { name: string; value: string }[];
};

export class AssertTraceStore {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<AssertTraceEntry[]>();
  readonly onDidChange = this.onDidChangeEmitter.event;
  private entries: AssertTraceEntry[] = [];
  private nextId = 1;

  constructor(private readonly maxEntries: number) {}

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  getEntries(): AssertTraceEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
    this.onDidChangeEmitter.fire(this.entries);
  }

  upsertPrompt(
    prompt: AssertPrompt,
    location: AssertLocation | null,
    recommendation: AssertRecommendation,
    registers?: { name: string; value: string }[]
  ): void {
    const key = this.promptKey(prompt);
    let entry = this.entries.find((item) => item.key === key && !item.response);
    if (!entry) {
      entry = {
        id: this.nextId++,
        key,
        time: Date.now(),
        type: prompt.type,
        addr: prompt.addr,
        size: prompt.size,
        pc: prompt.pc,
        register: prompt.register,
        peripheral: prompt.peripheral,
        reset: prompt.reset,
        value: prompt.value,
        fields: prompt.fields,
        hints: [...prompt.hints],
        decisions: [...prompt.decisions],
        recommendation,
        location: location ?? undefined,
        registers: registers && registers.length ? [...registers] : undefined,
      };
      this.entries.unshift(entry);
      this.trim();
    } else {
      entry.register = prompt.register ?? entry.register;
      entry.peripheral = prompt.peripheral ?? entry.peripheral;
      entry.reset = prompt.reset ?? entry.reset;
      entry.value = prompt.value ?? entry.value;
      entry.fields = prompt.fields ?? entry.fields;
      entry.hints = [...prompt.hints];
      entry.decisions = [...prompt.decisions];
      entry.recommendation = recommendation;
      if (registers && registers.length) {
        entry.registers = [...registers];
      }
      if (location) {
        entry.location = location;
      }
    }
    this.onDidChangeEmitter.fire(this.entries);
  }

  markResponse(prompt: AssertPrompt | null, response: string): void {
    if (!prompt) {
      return;
    }
    const key = this.promptKey(prompt);
    const entry = this.entries.find((item) => item.key === key && !item.response) ??
      this.entries.find((item) => item.key === key);
    if (!entry) {
      return;
    }
    entry.response = response;
    entry.responseAt = Date.now();
    this.onDidChangeEmitter.fire(this.entries);
  }

  private trim(): void {
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(0, this.maxEntries);
    }
  }

  private promptKey(prompt: AssertPrompt): string {
    return `${prompt.type}:${prompt.addr.toString(16)}:${prompt.pc.toString(16)}:${prompt.size}`;
  }
}

export class AssertTracePanel implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private messageDisposable: vscode.Disposable | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: AssertTraceStore,
    private readonly onOpenLocation: (path: string, line: number) => void
  ) {}

  dispose(): void {
    if (this.messageDisposable) {
      this.messageDisposable.dispose();
      this.messageDisposable = null;
    }
    this.view = null;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);

    // Dispose old message handler if exists
    if (this.messageDisposable) {
      this.messageDisposable.dispose();
    }

    this.messageDisposable = webviewView.webview.onDidReceiveMessage((message: any) => {
      if (message?.type === "open") {
        const path = String(message.path ?? "");
        const line = Number.parseInt(message.line ?? "", 10);
        if (path && Number.isFinite(line)) {
          this.onOpenLocation(path, line);
        }
      }
      if (message?.type === "clear") {
        this.store.clear();
      }
    });

    webviewView.onDidDispose(() => {
      if (this.messageDisposable) {
        this.messageDisposable.dispose();
        this.messageDisposable = null;
      }
      this.view = null;
    });

    this.postEntries();
  }

  show(): void {
    if (this.view) {
      // Force reveal the view
      if (typeof this.view.show === 'function') {
        this.view.show(true);
      }
    }
  }

  reveal(): void {
    if (this.view && typeof this.view.show === "function") {
      this.view.show(true);
      return;
    }
    // Don't use executeCommand("...focus") — it steals cursor focus from the editor.
    // The panel will render when the user opens the sidebar or VS Code resolves the view.
  }

  refresh(): void {
    if (this.view) {
      this.postEntries();
    }
  }

  private postEntries(): void {
    if (!this.view || !this.view.webview) {
      return;
    }
    try {
      this.view.webview.postMessage({ type: "update", entries: this.store.getEntries() });
    } catch (err) {
      // Webview may not be ready yet, ignore
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const initial = JSON.stringify(this.store.getEntries());
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <style>
      * { box-sizing: border-box; }
      body {
        font-family: var(--vscode-font-family);
        margin: 0;
        padding: 10px;
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
      }
      .toolbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 8px;
      }
      .title { font-size: 12px; font-weight: 700; letter-spacing: 0.4px; }
      button {
        border: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 15%, transparent);
        border-radius: 6px;
        padding: 4px 8px;
        font-size: 11px;
        cursor: pointer;
        color: var(--vscode-button-secondaryForeground);
        background: var(--vscode-button-secondaryBackground);
      }
      button:hover { background: var(--vscode-button-secondaryHoverBackground); }
      .empty {
        color: var(--vscode-descriptionForeground);
        padding: 14px 4px;
      }
      .timeline { position: relative; padding-left: 16px; }
      .timeline::before {
        content: "";
        position: absolute;
        left: 5px;
        top: 0;
        bottom: 0;
        width: 2px;
        background: color-mix(in srgb, var(--vscode-editor-foreground) 14%, transparent);
      }
      .entry {
        position: relative;
        margin-bottom: 10px;
        padding: 8px;
        border: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 14%, transparent);
        border-radius: 8px;
        background: color-mix(in srgb, var(--vscode-editorWidget-background) 84%, var(--vscode-editor-background));
      }
      .dot {
        position: absolute;
        left: -16px;
        top: 14px;
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--vscode-testing-iconPassed);
      }
      .dot.write { background: var(--vscode-testing-iconFailed); }
      .head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
      }
      .kind {
        font-size: 11px;
        font-weight: 700;
        padding: 1px 6px;
        border: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 18%, transparent);
        border-radius: 999px;
      }
      .target { font-size: 12px; font-weight: 600; }
      .time { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 11px; }
      .meta, .detail, .regs {
        margin-top: 6px;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        line-height: 1.35;
      }
      .actions { margin-top: 7px; display: flex; gap: 6px; }
      .mono { font-family: var(--vscode-editor-font-family); }
    </style>
  </head>
  <body>
    <div class="toolbar">
      <div class="title">Assert Trace</div>
      <button id="clear">Clear</button>
    </div>
    <div id="root"></div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const root = document.getElementById("root");
      const clearButton = document.getElementById("clear");
      clearButton.addEventListener("click", () => {
        vscode.postMessage({ type: "clear" });
      });

      function formatTime(ms) {
        const date = new Date(ms);
        return date.toLocaleTimeString();
      }

      function render(entries) {
        root.innerHTML = "";
        if (!entries.length) {
          root.innerHTML = '<div class="empty">No assert events yet.</div>';
          return;
        }
        const timeline = document.createElement("div");
        timeline.className = "timeline";
        for (const entry of entries) {
          const container = document.createElement("div");
          container.className = "entry";

          const dot = document.createElement("div");
          dot.className = "dot " + (entry.type === "write" ? "write" : "read");
          container.appendChild(dot);

          const head = document.createElement("div");
          head.className = "head";
          const kindSpan = document.createElement("span");
          kindSpan.className = "kind";
          kindSpan.textContent = entry.type.toUpperCase();
          const targetSpan = document.createElement("span");
          targetSpan.className = "target";
          targetSpan.textContent = entry.register || entry.peripheral || ("0x" + entry.addr.toString(16));
          const timeSpan = document.createElement("span");
          timeSpan.className = "time";
          timeSpan.textContent = formatTime(entry.time);
          head.appendChild(kindSpan);
          head.appendChild(targetSpan);
          head.appendChild(timeSpan);
          container.appendChild(head);

          const meta = document.createElement("div");
          meta.className = "meta mono";
          meta.textContent =
            "MMIO " + entry.type.toUpperCase() +
            " (PC: 0x" + entry.pc.toString(16) + ") -> " + (entry.register || entry.peripheral || ("0x" + entry.addr.toString(16))) +
            " | (addr 0x" + entry.addr.toString(16).padStart(8, "0") + ", " + (entry.size * 8) + " bits)";
          container.appendChild(meta);

          const detailParts = [];
          if (entry.reset) detailParts.push("Reset: " + entry.reset);
          if (entry.value && entry.type === "write") detailParts.push("Value: " + entry.value);
          if (entry.fields) detailParts.push("Fields: " + entry.fields);
          if (entry.recommendation) detailParts.push("Recommend: " + entry.recommendation.action + " (" + entry.recommendation.reason + ")");
          if (entry.response !== undefined) {
            const responseLabel = entry.response === "" ? "Default" : entry.response === "-" ? "Ignore" : entry.response;
            detailParts.push("Response: " + responseLabel);
          }
          if (entry.hints && entry.hints.length) detailParts.push("Hints: " + entry.hints.join(" | "));
          if (detailParts.length) {
            const detail = document.createElement("div");
            detail.className = "detail";
            detail.textContent = detailParts.join(" | ");
            container.appendChild(detail);
          }

          if (entry.registers && entry.registers.length) {
            const regs = document.createElement("div");
            regs.className = "regs mono";
            const preview = entry.registers
              .slice(0, 24)
              .map((reg) => reg.name + "=" + reg.value)
              .join(" ");
            regs.textContent = "Regs: " + preview + (entry.registers.length > 24 ? " ..." : "");
            container.appendChild(regs);
          }

          if (entry.location) {
            const row = document.createElement("div");
            row.className = "actions";
            const open = document.createElement("button");
            open.textContent = "Open " + entry.location.path + ":" + entry.location.line;
            open.addEventListener("click", () => {
              vscode.postMessage({ type: "open", path: entry.location.path, line: entry.location.line });
            });
            row.appendChild(open);
            container.appendChild(row);
          }

          timeline.appendChild(container);
        }
        root.appendChild(timeline);
      }

      window.addEventListener("message", (event) => {
        if (event.data?.type === "update") {
          render(event.data.entries || []);
        }
      });

      render(${initial});
    </script>
  </body>
</html>`;
  }
}

function getNonce(): string {
  return crypto.randomBytes(24).toString("base64url");
}
