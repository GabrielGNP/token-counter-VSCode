import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { countTokens as anthropicCountTokens } from '@anthropic-ai/tokenizer';

// ---------------------------------------------------------------------------
// Tokenizer — official @anthropic-ai/tokenizer (Claude's actual tokenizer)
// ---------------------------------------------------------------------------
function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return anthropicCountTokens(text);
  } catch {
    return Math.ceil(text.length / 4); // fallback
  }
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tokens`;
  return `${n} tokens`;
}

// ---------------------------------------------------------------------------
// TokenColorProvider — only responds to scheme "token-counter://"
// so the native Explorer is never affected.
// ---------------------------------------------------------------------------
class TokenColorProvider implements vscode.FileDecorationProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this._onDidChange.event;

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'token-counter') return undefined;
    const level = uri.authority;
    if (level === 'danger') return { color: new vscode.ThemeColor('errorForeground'), propagate: false };
    if (level === 'warn')   return { color: new vscode.ThemeColor('editorWarning.foreground'), propagate: false };
    return undefined;
  }
}

function colorUri(fsPath: string, level: 'ok' | 'warn' | 'danger'): vscode.Uri {
  return vscode.Uri.from({ scheme: 'token-counter', authority: level, path: '/', query: fsPath });
}

// ---------------------------------------------------------------------------
// TreeDataProvider
// ---------------------------------------------------------------------------
class FileNode {
  constructor(public readonly uri: vscode.Uri, public readonly isDir: boolean) {}
}

class TokenTreeProvider implements vscode.TreeDataProvider<FileNode> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private cache = new Map<string, number>();
  private config: vscode.WorkspaceConfiguration;

  constructor() {
    this.config = vscode.workspace.getConfiguration('tokenCounter');
  }

  reloadConfig() { this.config = vscode.workspace.getConfiguration('tokenCounter'); }

  refresh(uri?: vscode.Uri) {
    if (uri) this.cache.delete(uri.fsPath);
    else this.cache.clear();
    this._onDidChange.fire();
  }

  getTreeItem(node: FileNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      path.basename(node.uri.fsPath),
      node.isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );
    item.resourceUri = node.uri;

    if (!node.isDir) {
      item.command = { command: 'vscode.open', title: 'Open', arguments: [node.uri] };

      const ext = path.extname(node.uri.fsPath).toLowerCase();
      const allowed = this.config.get<string[]>('includeExtensions', []);

      if (allowed.includes(ext)) {
        if (!this.cache.has(node.uri.fsPath)) {
          try {
            const content = fs.readFileSync(node.uri.fsPath, 'utf8');
            this.cache.set(node.uri.fsPath, countTokens(content));
          } catch { /* unreadable */ }
        }
        const tokens = this.cache.get(node.uri.fsPath);
        if (tokens !== undefined) {
          item.description = formatTokens(tokens);
          item.tooltip = `~${tokens.toLocaleString()} tokens`;

          const warn   = this.config.get<number>('warningThreshold', 2000);
          const danger = this.config.get<number>('dangerThreshold', 8000);
          const level  = tokens >= danger ? 'danger' : tokens >= warn ? 'warn' : 'ok';
          item.resourceUri = colorUri(node.uri.fsPath, level);
        }
      }
    }
    return item;
  }

  getChildren(node?: FileNode): vscode.ProviderResult<FileNode[]> {
    if (!node) {
      return (vscode.workspace.workspaceFolders ?? []).map(f => new FileNode(f.uri, true));
    }
    const hidden = new Set(['.git', 'node_modules', 'out', 'dist', '.DS_Store']);
    try {
      return fs.readdirSync(node.uri.fsPath, { withFileTypes: true })
        .filter(e => !hidden.has(e.name))
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .map(e => new FileNode(
          vscode.Uri.file(path.join(node.uri.fsPath, e.name)),
          e.isDirectory()
        ));
    } catch { return []; }
  }
}

// ---------------------------------------------------------------------------
// Activate
// ---------------------------------------------------------------------------
export function activate(context: vscode.ExtensionContext) {
  const colorProvider = new TokenColorProvider();
  const treeProvider  = new TokenTreeProvider();

  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(colorProvider)
  );

  const view = vscode.window.createTreeView('tokenCounterExplorer', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(view);

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(doc => treeProvider.refresh(doc.uri))
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('tokenCounter')) {
        treeProvider.reloadConfig();
        treeProvider.refresh();
      }
    })
  );

  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  context.subscriptions.push(
    watcher.onDidCreate(() => treeProvider.refresh()),
    watcher.onDidDelete(() => treeProvider.refresh()),
    watcher.onDidChange(uri => treeProvider.refresh(uri)),
    watcher
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('tokenCounter.refresh', () => {
      treeProvider.refresh();
      vscode.window.showInformationMessage('Token Counter: refreshed.');
    }),
    vscode.commands.registerCommand('tokenCounter.toggle', () => {
      const cfg = vscode.workspace.getConfiguration('tokenCounter');
      const next = !cfg.get<boolean>('enabled', true);
      cfg.update('enabled', next, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Token Counter: ${next ? 'enabled' : 'disabled'}.`);
    })
  );
}

export function deactivate() {}
