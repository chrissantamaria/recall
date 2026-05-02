import * as vscode from 'vscode';

import type { RemoteInfo } from '../git/remote';

export interface CommitInfo {
  hash: string;
  subject: string;
  body?: string;
  authorName?: string;
  authorEmail?: string;
  authorDate?: Date;
}

export interface DiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface TooltipOpts {
  avatarDataUri?: string;
  remote?: RemoteInfo;
  diffStat?: DiffStat;
  truncateBody?: boolean;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function relativeTime(date: Date | undefined): string {
  if (!date) return '';
  const diffMs = Date.now() - date.getTime();
  const s = Math.max(1, Math.floor(diffMs / 1000));
  if (s < 60) return plural(s, 'second');
  const m = Math.floor(s / 60);
  if (m < 60) return plural(m, 'minute');
  const h = Math.floor(m / 60);
  if (h < 24) return plural(h, 'hour');
  const d = Math.floor(h / 24);
  if (d < 30) return plural(d, 'day');
  const mo = Math.floor(d / 30);
  if (mo < 12) return plural(mo, 'month');
  const y = Math.floor(d / 365);
  return plural(y, 'year');
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

function escapeMdMinimal(text: string): string {
  // Only escape a backslash so inline backslashes in commit text don't eat adjacent
  // characters. We leave every other markdown-significant character untouched so
  // authored markdown (bold, italics, code spans, links) renders naturally.
  return text.replace(/\\/g, '\\\\');
}

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Inject a link for every bare `#NNN` reference (and, on GitLab-family remotes,
 * `!NNN` merge-request references) while preserving the rest of the text as-is.
 * We emit an HTML `<a>` rather than a markdown `[text](url)` because this
 * function's output is rendered inside the `<table>`-wrapped title (where
 * markdown-it leaves block HTML contents untouched). HTML anchors render both
 * inside the table and in the paragraph-level body, so one code path works for
 * both call sites.
 *
 * Skipped cases:
 * - `[#123](custom-url)` - already a user-authored link; leave alone.
 */
function linkifyIssues(
  subject: string,
  remote: RemoteInfo | undefined,
): string {
  if (!remote) return escapeMdMinimal(subject);
  // `!N` is only linkified when the remote explicitly supports merge requests
  // (GitLab). On GitHub `!N` is not a reference syntax, so we leave it alone.
  const pattern = remote.mergeRequestUrl
    ? /(?<sigil>[#!])(?<num>\d+)/g
    : /(?<sigil>#)(?<num>\d+)/g;
  let out = '';
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(subject)) !== null) {
    const before = subject.slice(lastIdx, m.index);
    out += escapeMdMinimal(before);
    const after = subject.slice(m.index + m[0].length);
    const alreadyLinked = after.startsWith('](');
    if (alreadyLinked) {
      out += m[0];
    } else {
      const sigil = m.groups?.sigil;
      const num = m.groups?.num;
      if (!sigil || !num) {
        out += m[0];
      } else {
        const n = parseInt(num, 10);
        const url =
          sigil === '!' && remote.mergeRequestUrl
            ? remote.mergeRequestUrl(n)
            : remote.issueUrl(n);
        out += `<a href="${escapeHtmlAttr(url)}">${sigil}${n}</a>`;
      }
    }
    lastIdx = m.index + m[0].length;
  }
  out += escapeMdMinimal(subject.slice(lastIdx));
  return out;
}

export function buildCommitTooltip(
  c: CommitInfo,
  opts: TooltipOpts = {},
): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.supportHtml = true;
  md.isTrusted = { enabledCommands: ['recall.copySha'] };

  // Header: avatar + author, relative time (absolute time)
  const authorLabel = escapeMdMinimal(c.authorName || c.authorEmail || '');
  let datePart = '';
  if (c.authorDate) {
    const rel = relativeTime(c.authorDate);
    const abs = formatLocalDateTime(c.authorDate);
    datePart = `, $(clock) ${rel} (${abs})`;
  }
  const headerText = `${authorLabel}${datePart}`;

  if (opts.avatarDataUri) {
    md.appendMarkdown(
      `<table><tr>` +
        `<td><img src="${opts.avatarDataUri}" width="20" height="20" /></td>` +
        `<td>&nbsp;${headerText}</td>` +
        `</tr></table>\n\n`,
    );
  } else {
    md.appendMarkdown(`${headerText}\n\n`);
  }

  // Subject
  const titleMd = linkifyIssues(c.subject, opts.remote);
  md.appendMarkdown(`**${titleMd}**\n\n`);

  // Body
  if (c.body && c.body.trim().length > 0) {
    const body = opts.truncateBody
      ? truncateBody(c.body.trim())
      : c.body.trim();
    md.appendMarkdown(linkifyIssues(body, opts.remote));
    md.appendMarkdown('\n\n');
  }

  // Stats line
  if (opts.diffStat) {
    const { filesChanged, insertions, deletions } = opts.diffStat;
    md.appendMarkdown('---\n\n');
    const parts: string[] = [];
    parts.push(`${filesChanged} file${filesChanged === 1 ? '' : 's'} changed`);
    if (insertions > 0)
      parts.push(
        `<span style="color:var(--vscode-scmGraph-historyItemHoverAdditionsForeground);">${insertions} insertion${insertions === 1 ? '' : 's'}(+)</span>`,
      );
    if (deletions > 0)
      parts.push(
        `<span style="color:var(--vscode-scmGraph-historyItemHoverDeletionsForeground);">${deletions} deletion${deletions === 1 ? '' : 's'}(-)</span>`,
      );
    md.appendMarkdown(`${parts.join(', ')}\n\n`);
  }

  // Footer: SHA with copy button + remote link
  md.appendMarkdown('---\n\n');
  const shortHash = shortSha(c.hash);
  const copyArgs = encodeURIComponent(JSON.stringify(c.hash));
  let footer = `$(git-commit) \`${shortHash}\` [$(copy)](command:recall.copySha?${copyArgs} "Copy commit SHA")`;
  if (opts.remote) {
    footer += ` &nbsp;|&nbsp; [$(globe) Open on Remote](${opts.remote.commitUrl(c.hash)})`;
  }
  md.appendMarkdown(footer);

  return md;
}

function truncateBody(body: string, maxLines = 20): string {
  const lines = body.split('\n');
  if (lines.length <= maxLines) return body;
  return lines.slice(0, maxLines).join('\n') + '\n\u2026';
}

function formatLocalDateTime(date: Date): string {
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function splitMessage(message: string): {
  subject: string;
  body: string;
} {
  const idx = message.indexOf('\n');
  if (idx === -1) return { subject: message.trim(), body: '' };
  return {
    subject: message.slice(0, idx).trim(),
    body: message.slice(idx + 1).trim(),
  };
}

export function parseDiffStat(raw: string): DiffStat | undefined {
  const m =
    /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(
      raw,
    );
  if (!m) return undefined;
  return {
    filesChanged: parseInt(m[1], 10),
    insertions: m[2] ? parseInt(m[2], 10) : 0,
    deletions: m[3] ? parseInt(m[3], 10) : 0,
  };
}
