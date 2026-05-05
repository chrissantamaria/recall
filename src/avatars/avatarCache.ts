import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as path from 'node:path';
import * as vscode from 'vscode';

const PALETTE = [
  '#C62828', // Red 800
  '#D81B60', // Pink 600
  '#8E24AA', // Purple 600
  '#5E35B1', // Deep Purple 600
  '#3949AB', // Indigo 600
  '#1565C0', // Blue 800
  '#01579B', // Light Blue 900
  '#006064', // Cyan 900
  '#004D40', // Teal 900
  '#2E7D32', // Green 800
  '#33691E', // Light Green 900
  '#827717', // Lime 900
  '#BF360C', // Deep Orange 900
  '#6D4C41', // Brown 600
  '#5D4037', // Brown 700
  '#4E342E', // Brown 800
];

export interface AvatarAssets {
  /** file:// Uri suitable for TreeItem.iconPath. Points to a file that is guaranteed to exist. */
  iconUri: vscode.Uri;
  /** data:image/...;base64,... Uri suitable for embedding inside MarkdownString tooltips. */
  dataUri: string;
}

interface CacheKey {
  name: string;
  email: string;
}

/**
 * Synthesizes a deterministic colored-initials SVG avatar per author.
 * Works fully offline. On first call the SVG is returned immediately; a background
 * fetch then attempts to upgrade it — first to a GitHub avatar (for no-reply addresses),
 * then to Gravatar — replacing the SVG on disk if a real image is found.
 */
export class AvatarCache {
  private readonly dirFsPath: string;
  private readonly assetsById = new Map<string, AvatarAssets>();
  private readonly upgradeAttempts = new Set<string>();
  private readonly _onDidCacheAvatar = new vscode.EventEmitter<void>();
  readonly onDidCacheAvatar = this._onDidCacheAvatar.event;

  constructor(context: vscode.ExtensionContext) {
    this.dirFsPath = path.join(context.globalStorageUri.fsPath, 'avatars');
    try {
      fs.mkdirSync(this.dirFsPath, { recursive: true });
    } catch {
      /* globalStorage should always be writable; if it isn't, we'll fail per-write below */
    }
  }

  /**
   * Synchronously returns avatar assets for the given author. On first call for a
   * given (email, name) we synthesize and persist an SVG before returning, so the
   * iconUri always points to an existing file.
   */
  getAssets(key: CacheKey): AvatarAssets {
    const id = this.idFor(key);
    const cached = this.assetsById.get(id);
    if (cached) {
      void this.maybeUpgradeAvatar(key, id);
      return cached;
    }

    const svg = renderAvatarSvg(key);
    const svgPath = path.join(this.dirFsPath, `${id}.svg`);
    try {
      // Synchronous write: VS Code reads the iconPath in the same tick we return it,
      // so an async write would leave a 404-shaped hole in the tree.
      fs.writeFileSync(svgPath, svg, 'utf8');
    } catch {
      /* fall through - worst case the file:// URI is unreadable and VS Code falls back to no icon */
    }

    const assets: AvatarAssets = {
      iconUri: vscode.Uri.file(svgPath),
      dataUri: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`,
    };
    this.assetsById.set(id, assets);
    void this.maybeUpgradeAvatar(key, id);
    return assets;
  }

  /** Convenience wrapper that handles undefined email/name. */
  get(email: string | undefined, name: string | undefined): AvatarAssets {
    return this.getAssets({ email: email ?? '', name: name ?? '' });
  }

  private idFor(key: CacheKey): string {
    const raw = `${(key.email || '').trim().toLowerCase()}|${(key.name || '').trim()}`;
    return crypto.createHash('md5').update(raw).digest('hex');
  }

  private async maybeUpgradeAvatar(key: CacheKey, id: string): Promise<void> {
    if (!key.email) return;
    if (this.upgradeAttempts.has(id)) return;
    this.upgradeAttempts.add(id);

    const url = githubAvatarUrl(key.email) ?? gravatarUrl(key.email);
    const buf = await fetchBinary(url);
    if (!buf) return;

    const imgPath = path.join(this.dirFsPath, `${id}.png`);
    try {
      fs.writeFileSync(imgPath, buf);
    } catch {
      return;
    }
    const dataUri = `data:image/png;base64,${Buffer.from(buf).toString('base64')}`;
    this.assetsById.set(id, { iconUri: vscode.Uri.file(imgPath), dataUri });
    this._onDidCacheAvatar.fire();
  }

  dispose(): void {
    this._onDidCacheAvatar.dispose();
  }
}

function renderAvatarSvg(key: CacheKey): string {
  const initials = deriveInitials(key.name, key.email);
  const bg = pickColor(key.email || key.name);
  // No <?xml ... ?> prolog - VS Code renders SVGs cleanly without it and avoids
  // any quirks with MarkdownString HTML parsing.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
  <rect width="96" height="96" fill="${bg}"/>
  <text x="48" y="50" text-anchor="middle" dominant-baseline="central" fill="#ffffff" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-weight="600" font-size="44">${escapeXml(initials)}</text>
</svg>`;
}

function deriveInitials(name: string, email: string): string {
  const cleanName = (name || '').trim();
  if (cleanName.length > 0) {
    const parts = cleanName.split(/\s+/).filter((p) => p.length > 0);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return parts[0].slice(0, 2).toUpperCase();
  }
  const local = (email || '').split('@')[0];
  if (local.length === 0) return '?';
  return local.slice(0, 2).toUpperCase();
}

function pickColor(seed: string): string {
  const hash = crypto
    .createHash('md5')
    .update(seed.trim().toLowerCase())
    .digest();
  return PALETTE[hash[0] % PALETTE.length];
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === '<'
      ? '&lt;'
      : c === '>'
        ? '&gt;'
        : c === '&'
          ? '&amp;'
          : c === "'"
            ? '&apos;'
            : '&quot;',
  );
}

// Matches GitHub's privacy no-reply format: {userId}+{login}@users.noreply.github.com
const GITHUB_NOREPLY_RE =
  /^(?:(?<userId>\d+)\+)?(?<login>[a-zA-Z\d-]{1,39})@users\.noreply\.github\.com$/i;

function githubAvatarUrl(email: string): string | undefined {
  const m = GITHUB_NOREPLY_RE.exec(email.trim());
  if (!m) return undefined;
  const { userId, login } = m.groups!;
  return userId
    ? `https://avatars.githubusercontent.com/u/${userId}?s=96`
    : `https://avatars.githubusercontent.com/${login}?s=96`;
}

function gravatarUrl(email: string): string {
  const hash = crypto
    .createHash('md5')
    .update(email.trim().toLowerCase())
    .digest('hex');
  return `https://www.gravatar.com/avatar/${hash}?s=96&d=404`;
}

function fetchBinary(url: string): Promise<Uint8Array | undefined> {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(undefined);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
      res.on('error', () => resolve(undefined));
    });
    req.on('error', () => resolve(undefined));
    req.on('timeout', () => {
      req.destroy();
      resolve(undefined);
    });
  });
}
