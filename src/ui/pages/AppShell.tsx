import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';
import { formatGreeting } from '@/lib/format';
import SettingsPage from './SettingsPage';

/**
 * Top-level shell layout with left navigation and main content area.
 */
export default function AppShell() {
  const [activeView, setActiveView] = useState<'workspace' | 'settings'>('settings');
  const [greeting, setGreeting] = useState<string>(formatGreeting('Supertree'));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (activeView === 'workspace') {
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

  return (
    <div className="grid h-screen grid-cols-[260px_1fr_320px] bg-slate-950 text-slate-100">
      <aside className="flex flex-col gap-4 border-r border-slate-800 p-4">
        <div className="text-xl font-semibold">Supertree</div>
        <div className="text-xs uppercase tracking-[0.2em] text-slate-500">Navigation</div>
        <div className="flex flex-col gap-2">
          <Button variant="outline" onClick={() => setActiveView('workspace')}>
            Home
          </Button>
          <Button variant="outline">Add repository</Button>
          <Button variant="outline">New workspace</Button>
        </div>
        <div className="mt-auto flex flex-col gap-2">
          <Button variant="outline" onClick={() => setActiveView('settings')}>
            Settings
          </Button>
          <div className="text-xs text-slate-500">M01 foundation</div>
        </div>
      </aside>

      <main className="flex h-full flex-col">
        <div className="flex items-center gap-4 border-b border-slate-800 px-6 py-3">
          <div className="text-sm font-medium">
            {activeView === 'settings' ? 'Settings' : 'All changes'}
          </div>
          {activeView === 'workspace' ? <div className="text-sm text-slate-500">Chat 1</div> : null}
        </div>
        <div className="flex-1 overflow-auto px-6 py-6">
          {activeView === 'settings' ? (
            <SettingsPage />
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
        {activeView === 'workspace' ? (
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
  );
}
