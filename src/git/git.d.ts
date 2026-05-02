import { Event, Uri } from 'vscode';

export interface Git {
  readonly path: string;
}

export const enum RefType {
  Head,
  RemoteHead,
  Tag,
}

export interface Ref {
  readonly type: RefType;
  readonly name?: string;
  readonly commit?: string;
  readonly remote?: string;
}

export interface UpstreamRef {
  readonly remote: string;
  readonly name: string;
  readonly commit?: string;
}

export interface Branch extends Ref {
  readonly upstream?: UpstreamRef;
  readonly ahead?: number;
  readonly behind?: number;
}

export interface CommitShortStat {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
}

export interface Commit {
  readonly hash: string;
  readonly message: string;
  readonly parents: string[];
  readonly authorDate?: Date;
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly commitDate?: Date;
  readonly shortStat?: CommitShortStat;
}

export interface LogOptions {
  readonly maxEntries?: number;
  readonly path?: string;
  readonly range?: string;
  readonly reverse?: boolean;
  readonly sortByAuthorDate?: boolean;
  readonly shortStats?: boolean;
  readonly author?: string;
  readonly grep?: string;
  readonly refNames?: string[];
  readonly maxParents?: number;
  readonly skip?: number;
}

export interface Remote {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
  readonly isReadOnly: boolean;
}

export interface RepositoryState {
  readonly HEAD: Branch | undefined;
  readonly remotes: Remote[];
  readonly onDidChange: Event<void>;
}

export interface Repository {
  readonly rootUri: Uri;
  readonly state: RepositoryState;
  log(options?: LogOptions): Promise<Commit[]>;
  show(ref: string, path: string): Promise<string>;
  getCommit(ref: string): Promise<Commit>;
  applyStash(index?: number): Promise<void>;
  popStash(index?: number): Promise<void>;
  dropStash(index?: number): Promise<void>;
  createStash(options?: {
    message?: string;
    includeUntracked?: boolean;
    staged?: boolean;
  }): Promise<void>;
}

export type APIState = 'uninitialized' | 'initialized';

export interface API {
  readonly state: APIState;
  readonly onDidChangeState: Event<APIState>;
  readonly git: Git;
  readonly repositories: Repository[];
  readonly onDidOpenRepository: Event<Repository>;
  readonly onDidCloseRepository: Event<Repository>;
  toGitUri(uri: Uri, ref: string): Uri;
  getRepository(uri: Uri): Repository | null;
}

export interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: Event<boolean>;
  getAPI(version: 1): API;
}
