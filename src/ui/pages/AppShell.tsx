import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';
import { formatGreeting } from '@/lib/format';
import type { OpenTarget, RepoInfo } from '@/types/repo';
import type { WorkspaceInfo } from '@/types/workspace';
import RepositoryPage from './RepositoryPage';
import SettingsPage from './SettingsPage';
import WorkspacePage from './WorkspacePage';
import WorkspacesPage from './WorkspacesPage';

/**
 * Top-level shell layout with left navigation and main content area.
 */
export default function AppShell() {
  const [activeView, setActiveView] = useState<
    'home' | 'settings' | 'repo' | 'workspaces' | 'workspace'
  >('settings');
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
  const addRepoRef = useRef<HTMLDivElement>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [workspaceMenuId, setWorkspaceMenuId] = useState<string | null>(null);
  const [workspaceMenuEl, setWorkspaceMenuEl] = useState<HTMLDivElement | null>(null);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [createWorkspaceMode, setCreateWorkspaceMode] = useState<'default' | 'branch'>(
    'default',
  );
  const [createWorkspaceBranch, setCreateWorkspaceBranch] = useState('');
  const [createWorkspaceRepoId, setCreateWorkspaceRepoId] = useState<string | null>(null);
  const [createWorkspaceState, setCreateWorkspaceState] = useState<
    'idle' | 'creating' | 'error'
  >('idle');
  const [createWorkspaceError, setCreateWorkspaceError] = useState<string | null>(null);
  const createWorkspaceRef = useRef<HTMLDivElement>(null);

  const selectedRepo = useMemo(
    () => repos.find((repo) => repo.id === selectedRepoId) ?? null,
    [repos, selectedRepoId],
  );
  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [workspaces, selectedWorkspaceId],
  );
  const selectedWorkspaceRepo = useMemo(() => {
    if (!selectedWorkspace) {
      return null;
    }
    return repos.find((repo) => repo.id === selectedWorkspace.repoId) ?? null;
  }, [repos, selectedWorkspace]);
  const workspacesByRepo = useMemo(() => {
    const grouped = new Map<string, WorkspaceInfo[]>();
    for (const workspace of workspaces) {
      if (workspace.state !== 'active') {
        continue;
      }
      const list = grouped.get(workspace.repoId) ?? [];
      list.push(workspace);
      grouped.set(workspace.repoId, list);
    }
    for (const list of grouped.values()) {
      list.sort((a, b) => {
        const aPinned = a.pinnedAt ? 0 : 1;
        const bPinned = b.pinnedAt ? 0 : 1;
        if (aPinned !== bPinned) {
          return aPinned - bPinned;
        }
        if (a.pinnedAt && b.pinnedAt) {
          return b.pinnedAt.localeCompare(a.pinnedAt);
        }
        return a.branch.localeCompare(b.branch);
      });
    }
    return grouped;
  }, [workspaces]);

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
    try {
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
    } catch (err) {
      setRepoError(String(err));
      setRepos([]);
      setSelectedRepoId(null);
      throw err;
    }
  }, []);

  const loadWorkspaces = useCallback(async () => {
    setWorkspaceError(null);
    try {
      const data = await invoke<WorkspaceInfo[]>('listWorkspaces');
      setWorkspaces(data);
    } catch (err) {
      setWorkspaceError(String(err));
      setWorkspaces([]);
      setSelectedWorkspaceId(null);
      throw err;
    }
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

  useEffect(() => {
    let active = true;
    loadWorkspaces().catch((err) => {
      if (active) {
        setWorkspaceError(String(err));
      }
    });
    return () => {
      active = false;
    };
  }, [loadWorkspaces]);

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

  const openCreateWorkspace = (repo: RepoInfo) => {
    setCreateWorkspaceRepoId(repo.id);
    setCreateWorkspaceMode('default');
    setCreateWorkspaceBranch('');
    setCreateWorkspaceError(null);
    setCreateWorkspaceState('idle');
    setCreateWorkspaceOpen(true);
  };

  const closeCreateWorkspace = useCallback(() => {
    setCreateWorkspaceOpen(false);
    setCreateWorkspaceError(null);
    setCreateWorkspaceState('idle');
    setCreateWorkspaceRepoId(null);
  }, []);

  const handleCreateWorkspace = async () => {
    if (!createWorkspaceRepoId) {
      return;
    }
    setCreateWorkspaceState('creating');
    setCreateWorkspaceError(null);
    try {
      const payload =
        createWorkspaceMode === 'default'
          ? { kind: 'default', repoId: createWorkspaceRepoId }
          : { kind: 'branch', repoId: createWorkspaceRepoId, branch: createWorkspaceBranch };
      const workspace = await invoke<WorkspaceInfo>('createWorkspace', payload);
      await loadWorkspaces();
      setSelectedWorkspaceId(workspace.id);
      setActiveView('workspace');
      closeCreateWorkspace();
    } catch (err) {
      setCreateWorkspaceState('error');
      setCreateWorkspaceError(String(err));
    }
  };

  const handleArchiveWorkspace = async (workspaceId: string) => {
    setWorkspaceError(null);
    try {
      await invoke('archiveWorkspace', { workspaceId });
      await loadWorkspaces();
      if (selectedWorkspaceId === workspaceId) {
        setSelectedWorkspaceId(null);
        setActiveView('workspaces');
      }
    } catch (err) {
      setWorkspaceError(String(err));
    }
  };

  const handleUnarchiveWorkspace = async (workspaceId: string) => {
    setWorkspaceError(null);
    try {
      await invoke('unarchiveWorkspace', { workspaceId });
      await loadWorkspaces();
    } catch (err) {
      setWorkspaceError(String(err));
    }
  };

  const handlePinWorkspace = async (workspaceId: string, pinned: boolean) => {
    setWorkspaceError(null);
    try {
      await invoke('pinWorkspace', { workspaceId, pinned });
      await loadWorkspaces();
    } catch (err) {
      setWorkspaceError(String(err));
    }
  };

  const handleUnreadWorkspace = async (workspaceId: string, unread: boolean) => {
    setWorkspaceError(null);
    try {
      await invoke('markWorkspaceUnread', { workspaceId, unread });
      await loadWorkspaces();
    } catch (err) {
      setWorkspaceError(String(err));
    }
  };

  const handleSelectWorkspace = async (workspace: WorkspaceInfo) => {
    setSelectedWorkspaceId(workspace.id);
    setActiveView('workspace');
    if (workspace.unread) {
      await handleUnreadWorkspace(workspace.id, false);
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
  const canCreateWorkspace =
    createWorkspaceState !== 'creating' &&
    (createWorkspaceMode === 'default' || createWorkspaceBranch.trim().length > 0);
  const createWorkspaceRepo = useMemo(
    () => repos.find((repo) => repo.id === createWorkspaceRepoId) ?? null,
    [createWorkspaceRepoId, repos],
  );

  useEffect(() => {
    if (!addRepoOpen) {
      return;
    }
    const modal = addRepoRef.current;
    if (!modal) {
      return;
    }

    const getFocusable = () =>
      Array.from(
        modal.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute('disabled'));

    const focusables = getFocusable();
    if (focusables.length > 0) {
      focusables[0].focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeAddRepo();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const items = getFocusable();
      if (items.length === 0) {
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [addRepoOpen, closeAddRepo]);

  useEffect(() => {
    if (!createWorkspaceOpen) {
      return;
    }
    const modal = createWorkspaceRef.current;
    if (!modal) {
      return;
    }

    const getFocusable = () =>
      Array.from(
        modal.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute('disabled'));

    const focusables = getFocusable();
    if (focusables.length > 0) {
      focusables[0].focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeCreateWorkspace();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const items = getFocusable();
      if (items.length === 0) {
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeCreateWorkspace, createWorkspaceOpen]);

  useEffect(() => {
    if (!workspaceMenuId) {
      if (workspaceMenuEl !== null) {
        setWorkspaceMenuEl(null);
      }
      return;
    }
    const handleClickOutside = (event: MouseEvent) => {
      if (workspaceMenuEl && !workspaceMenuEl.contains(event.target as Node)) {
        setWorkspaceMenuId(null);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setWorkspaceMenuId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [workspaceMenuEl, workspaceMenuId]);

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
            <Button variant="outline" onClick={() => setActiveView('workspaces')}>
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
                  const repoWorkspaces = workspacesByRepo.get(repo.id) ?? [];
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
                            <Button size="sm" variant="outline" onClick={() => openCreateWorkspace(repo)}>
                              New workspace
                            </Button>
                          </div>
                          {repoWorkspaces.length === 0 ? (
                            <div className="mt-2 text-xs text-slate-500">No workspaces yet.</div>
                          ) : (
                            <div className="mt-3 flex flex-col gap-2">
                              {repoWorkspaces.map((workspace) => {
                                const isWorkspaceSelected =
                                  workspace.id === selectedWorkspaceId;
                                const isMenuOpen = workspaceMenuId === workspace.id;
                                return (
                                  <div
                                    key={workspace.id}
                                    className="flex items-center justify-between gap-2"
                                  >
                                    <button
                                      type="button"
                                      onClick={() => handleSelectWorkspace(workspace)}
                                      className={`flex flex-1 items-center gap-2 text-left text-xs ${
                                        isWorkspaceSelected
                                          ? 'text-slate-100'
                                          : 'text-slate-300 hover:text-slate-100'
                                      }`}
                                    >
                                      <span className="truncate">{workspace.branch}</span>
                                      {workspace.pinnedAt ? (
                                        <span className="text-[10px] uppercase tracking-widest text-slate-500">
                                          Pinned
                                        </span>
                                      ) : null}
                                      {workspace.unread ? (
                                        <span className="h-2 w-2 rounded-full bg-amber-400" />
                                      ) : null}
                                    </button>
                                    <div
                                      className="relative"
                                      ref={(node) => {
                                        if (workspace.id === workspaceMenuId) {
                                          setWorkspaceMenuEl(node);
                                        }
                                      }}
                                    >
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setWorkspaceMenuId((prev) =>
                                            prev === workspace.id ? null : workspace.id,
                                          )
                                        }
                                        className="text-xs text-slate-500 hover:text-slate-200"
                                      >
                                        ...
                                      </button>
                                      {isMenuOpen ? (
                                        <div className="absolute right-0 mt-2 w-40 rounded-md border border-slate-800 bg-slate-950 p-2 text-xs shadow-xl">
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setWorkspaceMenuId(null);
                                              void handlePinWorkspace(
                                                workspace.id,
                                                !workspace.pinnedAt,
                                              );
                                            }}
                                            className="w-full rounded-md px-3 py-2 text-left text-slate-200 hover:bg-slate-900"
                                          >
                                            {workspace.pinnedAt ? 'Unpin' : 'Pin'}
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setWorkspaceMenuId(null);
                                              void handleArchiveWorkspace(workspace.id);
                                            }}
                                            className="w-full rounded-md px-3 py-2 text-left text-slate-200 hover:bg-slate-900"
                                          >
                                            Archive
                                          </button>
                                          <button
                                            type="button"
                                            disabled={workspace.unread}
                                            onClick={() => {
                                              setWorkspaceMenuId(null);
                                              void handleUnreadWorkspace(workspace.id, true);
                                            }}
                                            className="w-full rounded-md px-3 py-2 text-left text-slate-200 hover:bg-slate-900 disabled:cursor-not-allowed disabled:text-slate-500"
                                          >
                                            Mark as Unread
                                          </button>
                                        </div>
                                      ) : null}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
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
            <div className="text-xs text-slate-500">M03 workspaces</div>
          </div>
        </aside>

        <main className="flex h-full flex-col">
          <div className="flex items-center gap-4 border-b border-slate-800 px-6 py-3">
            <div className="text-sm font-medium">
              {activeView === 'settings'
                ? 'Settings'
                : activeView === 'repo'
                  ? selectedRepo?.name ?? 'Repository'
                  : activeView === 'workspace'
                    ? selectedWorkspace?.branch ?? 'Workspace'
                    : activeView === 'workspaces'
                      ? 'Workspaces'
                  : 'Home'}
            </div>
            {activeView === 'home' ? <div className="text-sm text-slate-500">Chat 1</div> : null}
          </div>
          <div className="flex-1 overflow-auto px-6 py-6">
            {workspaceError ? (
              <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {workspaceError}
              </div>
            ) : null}
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
            ) : activeView === 'workspaces' ? (
              <WorkspacesPage
                workspaces={workspaces}
                repos={repos}
                onOpen={handleSelectWorkspace}
                onUnarchive={handleUnarchiveWorkspace}
              />
            ) : activeView === 'workspace' ? (
              selectedWorkspace ? (
                <WorkspacePage
                  workspace={selectedWorkspace}
                  repo={selectedWorkspaceRepo}
                  onArchive={() => handleArchiveWorkspace(selectedWorkspace.id)}
                  onUnarchive={() => handleUnarchiveWorkspace(selectedWorkspace.id)}
                />
              ) : (
                <div className="rounded-md border border-slate-800 bg-slate-900/40 p-4 text-sm text-slate-400">
                  Select a workspace from the sidebar to view its details.
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

      {createWorkspaceOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-6">
          <div
            ref={createWorkspaceRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-workspace-title"
            className="w-full max-w-lg rounded-lg border border-slate-800 bg-slate-950 p-6 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-[0.3em] text-slate-500">Workspace</div>
                <h2 id="create-workspace-title" className="mt-2 text-xl font-semibold">
                  New workspace
                </h2>
                {createWorkspaceRepo ? (
                  <div className="mt-1 text-xs text-slate-400">{createWorkspaceRepo.name}</div>
                ) : null}
              </div>
              <button
                type="button"
                onClick={closeCreateWorkspace}
                className="text-sm text-slate-400 hover:text-slate-100"
              >
                Close
              </button>
            </div>

            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setCreateWorkspaceMode('default')}
                className={`rounded-md px-3 py-2 text-sm ${
                  createWorkspaceMode === 'default'
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
                }`}
              >
                Default branch
              </button>
              <button
                type="button"
                onClick={() => setCreateWorkspaceMode('branch')}
                className={`rounded-md px-3 py-2 text-sm ${
                  createWorkspaceMode === 'branch'
                    ? 'bg-slate-800 text-slate-100'
                    : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
                }`}
              >
                Existing branch
              </button>
            </div>

            {createWorkspaceMode === 'branch' ? (
              <div className="mt-4">
                <label
                  htmlFor="workspace-branch"
                  className="text-xs uppercase tracking-widest text-slate-500"
                >
                  Branch name
                </label>
                <input
                  id="workspace-branch"
                  value={createWorkspaceBranch}
                  onChange={(event) => setCreateWorkspaceBranch(event.target.value)}
                  placeholder="feature/new-workspace"
                  className="mt-2 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                />
              </div>
            ) : (
              <div className="mt-4 text-sm text-slate-400">
                A workspace will be created from the repository default branch.
              </div>
            )}

            {createWorkspaceError ? (
              <div className="mt-3 text-sm text-red-400">{createWorkspaceError}</div>
            ) : null}

            <div className="mt-6 flex items-center justify-end gap-2">
              <Button variant="outline" onClick={closeCreateWorkspace}>
                Cancel
              </Button>
              <Button onClick={handleCreateWorkspace} disabled={!canCreateWorkspace}>
                {createWorkspaceState === 'creating' ? 'Creating...' : 'Create workspace'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {addRepoOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-6">
          <div
            ref={addRepoRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-repo-title"
            className="w-full max-w-lg rounded-lg border border-slate-800 bg-slate-950 p-6 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-[0.3em] text-slate-500">Repository</div>
                <h2 id="add-repo-title" className="mt-2 text-xl font-semibold">
                  Add repository
                </h2>
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
