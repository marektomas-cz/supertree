import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { RepoInfo } from '@/types/repo';
import type { WorkspaceInfo } from '@/types/workspace';

type WorkspacesPageProps = {
  workspaces: WorkspaceInfo[];
  repos: RepoInfo[];
  onOpen: (workspace: WorkspaceInfo) => void;
  onUnarchive: (workspaceId: string) => void;
};

export default function WorkspacesPage({
  workspaces,
  repos,
  onOpen,
  onUnarchive,
}: WorkspacesPageProps) {
  const [filter, setFilter] = useState('');
  const repoLookup = useMemo(() => {
    const map = new Map<string, RepoInfo>();
    repos.forEach((repo) => map.set(repo.id, repo));
    return map;
  }, [repos]);
  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) {
      return workspaces;
    }
    return workspaces.filter((workspace) => {
      const repo = repoLookup.get(workspace.repoId);
      const repoName = repo?.name ?? '';
      return (
        workspace.branch.toLowerCase().includes(query) ||
        repoName.toLowerCase().includes(query)
      );
    });
  }, [filter, repoLookup, workspaces]);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Workspaces</h1>
        <p className="mt-2 text-sm text-slate-400">
          Manage active and archived workspaces across repositories.
        </p>
      </header>

      <div>
        <label htmlFor="workspace-filter" className="text-xs uppercase tracking-widest text-slate-500">
          Filter workspaces...
        </label>
        <input
          id="workspace-filter"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter workspaces..."
          className="mt-2 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-md border border-slate-800 bg-slate-900/40 p-4 text-sm text-slate-400">
          No workspaces found.
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((workspace) => {
            const repo = repoLookup.get(workspace.repoId);
            return (
              <div
                key={workspace.id}
                className="rounded-lg border border-slate-800 bg-slate-900/40 p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <div className="text-xs uppercase tracking-widest text-slate-500">
                      {repo?.name ?? 'Unknown repository'}
                    </div>
                    <div className="mt-2 text-lg font-semibold">{workspace.branch}</div>
                    <div className="mt-1 text-sm text-slate-400">
                      {workspace.state === 'archived' ? 'Archived workspace' : 'Active workspace'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {workspace.state === 'archived' ? (
                      <Button size="sm" onClick={() => onUnarchive(workspace.id)}>
                        Unarchive
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => onOpen(workspace)}>
                        Open
                      </Button>
                    )}
                  </div>
                </div>
                <div className="mt-3 grid gap-2 text-sm text-slate-300">
                  <div>
                    <span className="text-slate-500">Path:</span> {workspace.path}
                  </div>
                  <div>
                    <span className="text-slate-500">Base port:</span>{' '}
                    {workspace.basePort ?? 'Not assigned'}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
