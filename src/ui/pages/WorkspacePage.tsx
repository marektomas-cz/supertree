import { Button } from '@/components/ui/button';
import type { RepoInfo } from '@/types/repo';
import type { WorkspaceInfo } from '@/types/workspace';

type WorkspacePageProps = {
  workspace: WorkspaceInfo;
  repo: RepoInfo | null;
  onArchive: () => void;
  onUnarchive: () => void;
};

export default function WorkspacePage({
  workspace,
  repo,
  onArchive,
  onUnarchive,
}: WorkspacePageProps) {
  const basePort = workspace.basePort;
  const portRange = basePort != null ? `${basePort}-${basePort + 9}` : 'Not assigned';

  return (
    <div className="flex h-full flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-[0.3em] text-slate-500">Workspace</div>
          <h1 className="mt-2 text-2xl font-semibold">{workspace.branch}</h1>
          <div className="mt-2 text-sm text-slate-400">
            {repo?.name ?? 'Unknown repository'}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {workspace.state === 'archived' ? (
            <Button variant="outline" onClick={onUnarchive}>
              Unarchive
            </Button>
          ) : (
            <Button variant="outline" onClick={onArchive}>
              Archive
            </Button>
          )}
        </div>
      </header>

      <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-5">
        <div className="text-xs uppercase tracking-widest text-slate-500">Details</div>
        <div className="mt-4 grid gap-2 text-sm text-slate-300">
          <div>
            <span className="text-slate-500">Status:</span>{' '}
            {workspace.state === 'archived' ? 'Archived' : 'Active'}
          </div>
          <div>
            <span className="text-slate-500">Path:</span> {workspace.path}
          </div>
          <div>
            <span className="text-slate-500">Base port:</span> {basePort ?? 'Not assigned'}
          </div>
          <div>
            <span className="text-slate-500">Reserved range:</span> {portRange}
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-5">
        <div className="text-xs uppercase tracking-widest text-slate-500">
          Working directories
        </div>
        <p className="mt-3 text-sm text-slate-400">
          Sparse checkout is supported by the backend. UI selection will be added next.
        </p>
        <div className="mt-4">
          <Button variant="outline" disabled>
            Select working directories
          </Button>
        </div>
      </section>
    </div>
  );
}
