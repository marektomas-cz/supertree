import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { OpenTarget, RepoInfo } from '@/types/repo';

type RepositoryPageProps = {
  repo: RepoInfo;
  onOpen: (target: OpenTarget) => void;
  onRemove: () => void;
};

export default function RepositoryPage({ repo, onOpen, onRemove }: RepositoryPageProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const menuItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const confirmRef = useRef<HTMLDivElement>(null);
  const focusedIndexRef = useRef(0);

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

  const openTargets = useMemo(
    () => [
      { id: 'system' as const, label: fileManagerLabel },
      { id: 'vscode' as const, label: 'VS Code' },
      { id: 'cursor' as const, label: 'Cursor' },
      { id: 'zed' as const, label: 'Zed' },
    ],
    [fileManagerLabel],
  );

  const setMenuFocus = useCallback(
    (index: number) => {
      if (openTargets.length === 0) {
        return;
      }
      const nextIndex = (index + openTargets.length) % openTargets.length;
      focusedIndexRef.current = nextIndex;
      setFocusedIndex(nextIndex);
      menuItemRefs.current[nextIndex]?.focus();
    },
    [openTargets.length],
  );

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    setMenuFocus(0);
    const buttonEl = openButtonRef.current;

    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case 'Escape':
          event.preventDefault();
          setMenuOpen(false);
          break;
        case 'ArrowDown':
          event.preventDefault();
          setMenuFocus(focusedIndexRef.current + 1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          setMenuFocus(focusedIndexRef.current - 1);
          break;
        case 'Home':
          event.preventDefault();
          setMenuFocus(0);
          break;
        case 'End':
          event.preventDefault();
          setMenuFocus(openTargets.length - 1);
          break;
        case 'Enter':
        case ' ': {
          event.preventDefault();
          const target = openTargets[focusedIndexRef.current];
          if (target) {
            setMenuOpen(false);
            onOpen(target.id);
          }
          break;
        }
        default:
          break;
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
      buttonEl?.focus();
    };
  }, [menuOpen, onOpen, openTargets, setMenuFocus]);

  useEffect(() => {
    if (!confirmOpen) {
      return;
    }

    const modal = confirmRef.current;
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
        setConfirmOpen(false);
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
  }, [confirmOpen]);

  const scriptRows = [
    { label: 'Setup', value: repo.scriptsSetup },
    { label: 'Run', value: repo.scriptsRun },
    { label: 'Archive', value: repo.scriptsArchive },
    { label: 'Run mode', value: repo.runScriptMode },
  ];

  const handleRemove = () => {
    setConfirmOpen(true);
  };

  const confirmRemove = () => {
    setConfirmOpen(false);
    onRemove();
  };

  return (
    <>
      <div className="flex h-full flex-col gap-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="text-xs uppercase tracking-[0.3em] text-slate-500">Repository</div>
            <h1 className="mt-2 text-2xl font-semibold">{repo.name}</h1>
          </div>
          <div className="relative" ref={menuRef}>
            <Button
              id="open-target-button"
              ref={openButtonRef}
              onClick={() => setMenuOpen((prev) => !prev)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls="open-target-menu"
            >
              Open
            </Button>
            {menuOpen ? (
              <div
                id="open-target-menu"
                role="menu"
                aria-labelledby="open-target-button"
                className="absolute right-0 mt-2 w-48 rounded-md border border-slate-800 bg-slate-950 p-2 shadow-xl"
              >
                {openTargets.map((target, index) => (
                  <button
                    key={target.id}
                    ref={(element) => {
                      menuItemRefs.current[index] = element;
                    }}
                    type="button"
                    role="menuitem"
                    tabIndex={focusedIndex === index ? 0 : -1}
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

      {confirmOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-6">
          <div
            ref={confirmRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="remove-repo-title"
            aria-describedby="remove-repo-body"
            className="w-full max-w-md rounded-lg border border-slate-800 bg-slate-950 p-6 shadow-2xl"
          >
            <div className="text-xs uppercase tracking-[0.3em] text-slate-500">Repository</div>
            <h2 id="remove-repo-title" className="mt-2 text-xl font-semibold">
              Remove repository
            </h2>
            <p id="remove-repo-body" className="mt-3 text-sm text-slate-300">
              Remove {repo.name}? This will delete associated workspaces and chats.
            </p>
            <div className="mt-6 flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmOpen(false)}>
                Cancel
              </Button>
              <Button onClick={confirmRemove}>Remove</Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
