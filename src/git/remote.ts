/**
 * Remote-URL → web-URL resolver.
 * Supports GitHub and GitLab (including common self-hosted deployments).
 * Anything else falls through so tooltips don't produce bad links.
 */

export type RemoteHost = 'github' | 'gitlab';

export interface RemoteInfo {
  commitUrl(sha: string): string;
  /**
   * Resolve a `#N` reference. For GitHub we route through `/issues/<n>`: the
   * server redirects to `/pull/<n>` when N is a PR, and `#N` is ambiguous in
   * commit messages anyway. For GitLab `#N` is always an issue by convention
   * (MRs are referenced as `!N` - see {@link mergeRequestUrl}).
   */
  issueUrl(n: number): string;
  /**
   * Resolve a `!N` merge-request reference. Only populated for GitLab-family
   * hosts; GitHub has no analogous syntax (`#N` covers both issues and PRs).
   */
  mergeRequestUrl?(n: number): string;
}

export type CustomRemotes = Record<string, RemoteHost>;

/**
 * Parse git remote URLs in any of the shapes git accepts:
 *   git@host:owner/repo(.git)?
 *   ssh://git@host/owner/repo(.git)?
 *   https://host/owner/repo(.git)?
 *   http://host/owner/repo(.git)?
 */
export function parseRemoteUrl(
  url: string,
  customRemotes?: CustomRemotes,
): RemoteInfo | undefined {
  const trimmed = url.trim();
  if (!trimmed) return undefined;

  let host: string | undefined;
  let path: string | undefined;

  // scp-like shorthand: git@host:owner/repo
  const scp = /^(?:[^@]+@)?(?<host>[^:]+):(?<path>[^:]+?)(?:\.git)?\/?$/.exec(
    trimmed,
  );
  if (scp && !trimmed.includes('://')) {
    host = scp.groups?.host;
    path = scp.groups?.path;
  } else {
    try {
      const u = new URL(trimmed);
      host = u.hostname;
      path = u.pathname
        .replace(/^\/+/, '')
        .replace(/\.git\/?$/, '')
        .replace(/\/+$/, '');
    } catch {
      return undefined;
    }
  }
  if (!host || !path) return undefined;

  const kind = detectHostKind(host, customRemotes);
  if (!kind) return undefined;

  const [owner, ...rest] = path.split('/');
  const repo = rest.join('/');
  if (!owner || !repo) return undefined;

  const commitUrl = (sha: string): string => {
    switch (kind) {
      case 'github':
        return `https://${host}/${owner}/${repo}/commit/${sha}`;
      case 'gitlab':
        return `https://${host}/${owner}/${repo}/-/commit/${sha}`;
    }
  };

  const issueUrl = (n: number): string => {
    switch (kind) {
      case 'github':
        return `https://${host}/${owner}/${repo}/issues/${n}`;
      case 'gitlab':
        return `https://${host}/${owner}/${repo}/-/issues/${n}`;
    }
  };

  const info: RemoteInfo = { commitUrl, issueUrl };
  if (kind === 'gitlab') {
    info.mergeRequestUrl = (n: number): string =>
      `https://${host}/${owner}/${repo}/-/merge_requests/${n}`;
  }
  return info;
}

// Word-boundary matches to avoid false positives like `mygithubmirror.com` or
// `gitlabrary.example.com`, while still catching self-hosted deployments such
// as `github.mycorp.io` or `gitlab.example.com`. Bitbucket is intentionally
// unsupported: bitbucket.org uses a different URL shape from Bitbucket Server,
// and hostname alone can't distinguish them - see gitlens `matcher.ts` for
// the URL-path regex they use for Bitbucket Server.
function detectHostKind(
  host: string,
  customRemotes?: CustomRemotes,
): RemoteHost | undefined {
  const h = host.toLowerCase();
  if (customRemotes?.[h]) return customRemotes[h];
  if (/\bgithub\b/.test(h)) return 'github';
  if (/\bgitlab\b/.test(h)) return 'gitlab';
  return undefined;
}
