import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { OpenTarget, RepoInfo } from '@/types/repo';

type RepositoryPageProps = {
  repo: RepoInfo;
  onOpen: (target: OpenTarget) => void;
  onRemove: () => void;
};

export default function RepositoryPage({ repo, onOpen, onRemove }: RepositoryPageProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const fileManagerLabel = useMemo(() => {
    const agent = navigator.userAgent;
    if (agent.includes('Mac')) {
      return 'Finder';
    }
    if (agent.includes('Win')) {
      return 'File Explorer';
    }
    return 'File Manager';
  }, []);

  const openTargets: { id: OpenTarget; label: string }[] = [
    { id: 'system', label: fileManagerLabel },
    { id: 'vscode', label: 'VS Code' },
    { id: 'cursor', label: 'Cursor' },
    { id: 'zed', label: 'Zed' },
  ];

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  const scriptRows = [
    { label: 'Setup', value: repo.scriptsSetup },
    { label: 'Run', value: repo.scriptsRun },
    { label: 'Archive', value: repo.scriptsArchive },
    { label: 'Run mode', value: repo.runScriptMode },
  ];

  const handleRemove = () => {
    const confirmed = window.confirm(
      `Remove ${repo.name}? This will delete associated workspaces and chats.`,
    );
    if (confirmed) {
      onRemove();
    }
  };

  return (
    <div className="flex h-full flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-[0.3em] text-slate-500">Repository</div>
          <h1 className="mt-2 text-2xl font-semibold">{repo.name}</h1>
        </div>
        <div className="relative" ref={menuRef}>
          <Button onClick={() => setMenuOpen((prev) => !prev)}>Open</Button>
          {menuOpen ? (
            <div className="absolute right-0 mt-2 w-48 rounded-md border border-slate-800 bg-slate-950 p-2 shadow-xl">
              {openTargets.map((target) => (
                <button
                  key={target.id}
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpen(target.id);
                  }}
                  className="w-full rounded-md px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-900"
                >
                  {target.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </header>

      <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-5">
        <div className="text-xs uppercase tracking-widest text-slate-500">Details</div>
        <div className="mt-4 grid gap-2 text-sm text-slate-300">
          <div>
            <span className="text-slate-500">Root path:</span> {repo.rootPath}
          </div>
          <div>
            <span className="text-slate-500">Default branch:</span> {repo.defaultBranch}
          </div>
          <div>
            <span className="text-slate-500">Remote:</span>{' '}
            {repo.remoteUrl ? repo.remoteUrl : 'No remote configured'}
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-slate-800 bg-slate-900/40 p-5">
        <div className="text-xs uppercase tracking-widest text-slate-500">supertree.json</div>
        <div className="mt-4 grid gap-2 text-sm text-slate-300">
          {scriptRows.map((row) => (
            <div key={row.label}>
              <span className="text-slate-500">{row.label}:</span>{' '}
              {row.value && row.value.length > 0 ? row.value : 'Not set'}
            </div>
          ))}
        </div>
      </section>

      <div className="mt-auto flex justify-end">
        <Button variant="outline" onClick={handleRemove}>
          Remove repository
        </Button>
      </div>
    </div>
  );
}
