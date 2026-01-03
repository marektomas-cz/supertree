import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';
import { formatGreeting } from '@/lib/format';
import type { OpenTarget, RepoInfo } from '@/types/repo';
import RepositoryPage from './RepositoryPage';
import SettingsPage from './SettingsPage';

/**
 * Top-level shell layout with left navigation and main content area.
 */
export default function AppShell() {
  const [activeView, setActiveView] = useState<'home' | 'settings' | 'repo'>('settings');
  const [greeting, setGreeting] = useState<string>(formatGreeting('Supertree'));
  const [error, setError] = useState<string | null>(null);
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [repoError, setRepoError] = useState<string | null>(null);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [expandedRepoIds, setExpandedRepoIds] = useState<Set<string>>(new Set());
  const [addRepoOpen, setAddRepoOpen] = useState(false);
  const [addRepoMode, setAddRepoMode] = useState<'local' | 'clone'>('local');
  const [localPath, setLocalPath] = useState('');
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneDestination, setCloneDestination] = useState('');
  const [addState, setAddState] = useState<'idle' | 'adding' | 'error'>('idle');
  const [addError, setAddError] = useState<string | null>(null);

  const selectedRepo = useMemo(
    () => repos.find((repo) => repo.id === selectedRepoId) ?? null,
    [repos, selectedRepoId],
  );

  const toggleRepo = useCallback((repoId: string) => {
    setExpandedRepoIds((prev) => {
      const next = new Set(prev);
      if (next.has(repoId)) {
        next.delete(repoId);
      } else {
        next.add(repoId);
      }
      return next;
    });
  }, []);

  const loadRepos = useCallback(async (nextSelectedId?: string) => {
    setRepoError(null);
    const data = await invoke<RepoInfo[]>('listRepos');
    setRepos(data);
    setSelectedRepoId((prev) => {
      if (nextSelectedId) {
        return nextSelectedId;
      }
      if (prev && data.some((repo) => repo.id === prev)) {
        return prev;
      }
      return null;
    });
  }, []);

  useEffect(() => {
    let active = true;
    if (activeView === 'home') {
      setError(null);
      invoke<string>('hello', { name: 'Supertree' })
        .then((message) => {
          if (active) {
            setGreeting(message);
          }
        })
        .catch((err) => {
          if (active) {
            setError(String(err));
          }
        });
    }

    return () => {
      active = false;
    };
  }, [activeView]);

  useEffect(() => {
    let active = true;
    loadRepos().catch((err) => {
      if (active) {
        setRepoError(String(err));
      }
    });
    return () => {
      active = false;
    };
  }, [loadRepos]);

  const handleAddRepo = async () => {
    setAddState('adding');
    setAddError(null);
    try {
      const payload =
        addRepoMode === 'local'
          ? { kind: 'local', path: localPath }
          : { kind: 'clone', url: cloneUrl, destination: cloneDestination || undefined };
      const repo = await invoke<RepoInfo>('addRepo', payload);
      await loadRepos(repo.id);
      setActiveView('repo');
      setAddRepoOpen(false);
      setLocalPath('');
      setCloneUrl('');
      setCloneDestination('');
      setAddState('idle');
    } catch (err) {
      setAddState('error');
      setAddError(String(err));
    }
  };

  const handleRemoveRepo = async (repoId: string) => {
    setRepoError(null);
    try {
      await invoke('removeRepo', { repoId });
      await loadRepos();
      setActiveView('home');
    } catch (err) {
      setRepoError(String(err));
    }
  };

  const handleOpenRepo = async (target: OpenTarget) => {
    if (!selectedRepo) {
      return;
    }
    setRepoError(null);
    try {
      await invoke('openPathIn', { path: selectedRepo.rootPath, target });
    } catch (err) {
      setRepoError(String(err));
    }
  };

  const closeAddRepo = useCallback(() => {
    setAddRepoOpen(false);
    setAddError(null);
    setAddState('idle');
  }, []);

  const canSubmitRepo =
    addState !== 'adding' &&
    (addRepoMode === 'local'
      ? localPath.trim().length > 0
      : cloneUrl.trim().length > 0);

  return (
    <>
      <div className="grid h-screen grid-cols-[260px_1fr_320px] bg-slate-950 text-slate-100">
        <aside className="flex flex-col gap-4 border-r border-slate-800 p-4">
          <div className="text-xl font-semibold">Supertree</div>
          <div className="text-xs uppercase tracking-[0.2em] text-slate-500">Navigation</div>
          <div className="flex flex-col gap-2">
            <Button variant="outline" onClick={() => setActiveView('home')}>
              Home
            </Button>
            <Button variant="outline" disabled>
              Workspaces
            </Button>
          </div>

          <div className="mt-2">
            <div className="text-xs uppercase tracking-[0.2em] text-slate-500">Repositories</div>
            <div className="mt-3 flex flex-col gap-3">
              {repos.length === 0 ? (
                <div className="rounded-md border border-slate-800/60 px-3 py-2 text-sm text-slate-500">
                  No repositories yet.
                </div>
              ) : (
                repos.map((repo) => {
                  const expanded = expandedRepoIds.has(repo.id);
                  const isSelected = repo.id === selectedRepoId;
                  return (
                    <div key={repo.id} className="rounded-md border border-slate-800/60">
                      <div className="flex items-center justify-between gap-2 px-3 py-2">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedRepoId(repo.id);
                            setActiveView('repo');
                          }}
                          className={`text-left text-sm font-medium ${
                            isSelected ? 'text-slate-100' : 'text-slate-300 hover:text-slate-100'
                          }`}
                        >
                          {repo.name}
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleRepo(repo.id)}
                          className="text-xs text-slate-500 hover:text-slate-200"
                        >
                          {expanded ? '-' : '+'}
                        </button>
                      </div>
                      {expanded ? (
                        <div className="border-t border-slate-800/60 px-3 py-3">
                          <div className="flex items-center gap-2">
                            <Button size="sm" variant="outline" disabled>
                              New workspace
                            </Button>
                            <Button size="sm" variant="outline" disabled>
                              ...
                            </Button>
                          </div>
                          <div className="mt-2 text-xs text-slate-500">No workspaces yet.</div>
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="mt-auto flex flex-col gap-2">
            <Button variant="outline" onClick={() => setAddRepoOpen(true)}>
              Add repository
            </Button>
            <Button variant="outline" onClick={() => setActiveView('settings')}>
              Settings
            </Button>
            <div className="text-xs text-slate-500">M02 repositories</div>
          </div>
        </aside>

        <main className="flex h-full flex-col">
          <div className="flex items-center gap-4 border-b border-slate-800 px-6 py-3">
            <div className="text-sm font-medium">
              {activeView === 'settings'
                ? 'Settings'
                : activeView === 'repo'
                  ? selectedRepo?.name ?? 'Repository'
                  : 'Home'}
            </div>
            {activeView === 'home' ? <div className="text-sm text-slate-500">Chat 1</div> : null}
          </div>
          <div className="flex-1 overflow-auto px-6 py-6">
            {repoError ? (
              <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {repoError}
              </div>
            ) : null}
            {activeView === 'settings' ? (
              <SettingsPage />
            ) : activeView === 'repo' ? (
              selectedRepo ? (
                <RepositoryPage
                  repo={selectedRepo}
                  onOpen={handleOpenRepo}
                  onRemove={() => handleRemoveRepo(selectedRepo.id)}
                />
              ) : (
                <div className="rounded-md border border-slate-800 bg-slate-900/40 p-4 text-sm text-slate-400">
                  Select a repository from the sidebar to view its details.
                </div>
              )
            ) : (
              <>
                <h1 className="text-2xl font-semibold">Workspace overview</h1>
                <p className="mt-2 text-sm text-slate-400">
                  This is the Tauri + React shell for Supertree. The panels match the final
                  layout and the backend command is wired through.
                </p>
                <div className="mt-6 rounded-lg border border-slate-800 bg-slate-900/60 p-4">
                  <div className="text-xs uppercase tracking-widest text-slate-500">Backend</div>
                  <div className="mt-2 text-sm">
                    {error ? `Error: ${error}` : `Rust says: ${greeting}`}
                  </div>
                </div>
              </>
            )}
          </div>
          {activeView === 'home' ? (
            <div className="border-t border-slate-800 px-6 py-4">
              <div className="text-xs uppercase tracking-widest text-slate-500">Composer</div>
              <div className="mt-2 h-12 rounded-md border border-slate-800 bg-slate-900/40" />
            </div>
          ) : null}
        </main>

        <aside className="flex h-full flex-col border-l border-slate-800">
          <div className="border-b border-slate-800 p-4">
            <div className="text-sm font-semibold">Version control</div>
            <div className="mt-3 flex gap-2">
              <Button size="sm">Create PR</Button>
              <Button size="sm" variant="outline">
                Review
              </Button>
            </div>
          </div>
          <div className="flex-1 border-b border-slate-800 p-4">
            <div className="text-xs uppercase tracking-widest text-slate-500">Changes</div>
            <div className="mt-2 text-sm text-slate-500">No changes yet.</div>
          </div>
          <div className="p-4">
            <div className="text-sm font-semibold">Run / Terminal</div>
            <div className="mt-3 flex gap-2">
              <Button size="sm">Run</Button>
              <Button size="sm" variant="outline">
                Terminal
              </Button>
            </div>
          </div>
        </aside>
      </div>

      {addRepoOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-6">
          <div className="w-full max-w-lg rounded-lg border border-slate-800 bg-slate-950 p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-[0.3em] text-slate-500">Repository</div>
                <h2 className="mt-2 text-xl font-semibold">Add repository</h2>
              </div>
              <button
                type="button"
                onClick={closeAddRepo}
                className="text-sm text-slate-400 hover:text-slate-100"
              >
                Close
              </button>
            </div>

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setAddRepoMode('local')}
                className={`rounded-md px-3 py-2 text-sm ${
                  addRepoMode === 'local'
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
                }`}
              >
                Local folder
              </button>
              <button
                type="button"
                onClick={() => setAddRepoMode('clone')}
                className={`rounded-md px-3 py-2 text-sm ${
                  addRepoMode === 'clone'
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
                }`}
              >
                Git URL
              </button>
            </div>

            {addRepoMode === 'local' ? (
              <div className="mt-4">
                <label htmlFor="local-path" className="text-xs uppercase tracking-widest text-slate-500">
                  Local path
                </label>
                <input
                  id="local-path"
                  value={localPath}
                  onChange={(event) => setLocalPath(event.target.value)}
                  placeholder="C:\\projects\\my-repo"
                  className="mt-2 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                />
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                <div>
                  <label htmlFor="clone-url" className="text-xs uppercase tracking-widest text-slate-500">
                    Git URL
                  </label>
                  <input
                    id="clone-url"
                    value={cloneUrl}
                    onChange={(event) => setCloneUrl(event.target.value)}
                    placeholder="https://github.com/org/repo.git"
                    className="mt-2 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                  />
                </div>
                <div>
                  <label
                    htmlFor="clone-destination"
                    className="text-xs uppercase tracking-widest text-slate-500"
                  >
                    Destination (optional)
                  </label>
                  <input
                    id="clone-destination"
                    value={cloneDestination}
                    onChange={(event) => setCloneDestination(event.target.value)}
                    placeholder="C:\\repos\\clone-target"
                    className="mt-2 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                  />
                </div>
              </div>
            )}

            {addError ? <div className="mt-3 text-sm text-red-400">{addError}</div> : null}

            <div className="mt-6 flex items-center justify-end gap-2">
              <Button variant="outline" onClick={closeAddRepo}>
                Cancel
              </Button>
              <Button onClick={handleAddRepo} disabled={!canSubmitRepo}>
                {addState === 'adding' ? 'Adding...' : 'Add repository'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
