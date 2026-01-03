export type RepoInfo = {
  id: string;
  name: string;
  rootPath: string;
  remoteUrl?: string | null;
  defaultBranch: string;
  scriptsSetup?: string | null;
  scriptsRun?: string | null;
  scriptsArchive?: string | null;
  runScriptMode?: string | null;
};

export type OpenTarget = 'system' | 'vscode' | 'cursor' | 'zed';
