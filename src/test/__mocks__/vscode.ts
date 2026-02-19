// Minimal vscode API mock for unit testing modules that import "vscode"

export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];

  get event(): (listener: (e: T) => void) => { dispose: () => void } {
    return (listener) => {
      this.listeners.push(listener);
      return {
        dispose: () => {
          const idx = this.listeners.indexOf(listener);
          if (idx >= 0) {
            this.listeners.splice(idx, 1);
          }
        },
      };
    };
  }

  fire(data: T): void {
    for (const listener of this.listeners) {
      listener(data);
    }
  }

  dispose(): void {
    this.listeners = [];
  }
}

export class Uri {
  readonly scheme: string;
  readonly fsPath: string;
  readonly path: string;

  private constructor(scheme: string, fsPath: string) {
    this.scheme = scheme;
    this.fsPath = fsPath;
    this.path = fsPath;
  }

  static file(path: string): Uri {
    return new Uri("file", path);
  }

  static parse(value: string): Uri {
    return new Uri("file", value);
  }

  toString(): string {
    return `${this.scheme}://${this.fsPath}`;
  }
}

export class Range {
  constructor(
    public readonly startLine: number,
    public readonly startCharacter: number,
    public readonly endLine: number,
    public readonly endCharacter: number
  ) {}

  get start() {
    return { line: this.startLine, character: this.startCharacter };
  }
  get end() {
    return { line: this.endLine, character: this.endCharacter };
  }
}

export class Selection extends Range {}

export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number
  ) {}
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3,
}

export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3,
}

const configStore: Record<string, any> = {};

export function __resetConfig(): void {
  for (const key of Object.keys(configStore)) {
    delete configStore[key];
  }
}

export const workspace = {
  getConfiguration: (_section?: string) => ({
    get: <T>(key: string, defaultValue?: T): T | undefined => {
      return (configStore[key] as T) ?? defaultValue;
    },
    update: async (key: string, value: unknown, _target?: ConfigurationTarget): Promise<void> => {
      configStore[key] = value;
    },
    has: (key: string): boolean => key in configStore,
    inspect: (_key: string) => undefined,
  }),
  workspaceFolders: undefined as { uri: Uri }[] | undefined,
  onDidChangeConfiguration: new EventEmitter<void>().event,
};

export const window = {
  activeTextEditor: undefined as any,
  showInformationMessage: async (..._args: any[]): Promise<any> => undefined,
  showWarningMessage: async (..._args: any[]): Promise<any> => undefined,
  showErrorMessage: async (..._args: any[]): Promise<any> => undefined,
  showQuickPick: async (..._args: any[]): Promise<any> => undefined,
  showOpenDialog: async (..._args: any[]): Promise<any> => undefined,
  showSaveDialog: async (..._args: any[]): Promise<any> => undefined,
  showTextDocument: async (..._args: any[]): Promise<any> => undefined,
  createOutputChannel: (_name: string) => ({
    appendLine: (_msg: string) => {},
    append: (_msg: string) => {},
    show: () => {},
    clear: () => {},
    dispose: () => {},
  }),
  onDidChangeActiveTextEditor: new EventEmitter<any>().event,
};

export const commands = {
  registerCommand: (_command: string, _callback: (...args: any[]) => any) => ({
    dispose: () => {},
  }),
  executeCommand: async (_command: string, ..._args: any[]): Promise<any> => undefined,
};

export const tasks = {
  registerTaskProvider: (_type: string, _provider: any) => ({
    dispose: () => {},
  }),
  executeTask: async (_task: any): Promise<any> => undefined,
  onDidEndTaskProcess: new EventEmitter<any>().event,
};

export const debug = {
  activeDebugSession: undefined as any,
  onDidChangeActiveDebugSession: new EventEmitter<any>().event,
  registerDebugAdapterDescriptorFactory: (_type: string, _factory: any) => ({
    dispose: () => {},
  }),
  registerDebugConfigurationProvider: (_type: string, _provider: any) => ({
    dispose: () => {},
  }),
};

export class CodeLens {
  constructor(
    public readonly range: Range,
    public readonly command?: any
  ) {}
}

export class CancellationTokenSource {
  token = { isCancellationRequested: false };
  cancel() {
    this.token.isCancellationRequested = true;
  }
  dispose() {}
}

export class DebugAdapterExecutable {
  constructor(
    public readonly command: string,
    public readonly args: string[],
    public readonly options?: any
  ) {}
}

export const languages = {
  registerCodeLensProvider: (_selector: any, _provider: any) => ({
    dispose: () => {},
  }),
};

export const extensions = {
  getExtension: (_id: string) => undefined,
};
