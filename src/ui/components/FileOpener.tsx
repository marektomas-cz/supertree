import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

type FileOpenerProps = {
  open: boolean;
  files: string[];
  recentFiles: string[];
  workspaceLabel?: string;
  onOpenChange: (open: boolean) => void;
  onOpenFile: (path: string) => void;
};

export default function FileOpener({
  open,
  files,
  recentFiles,
  workspaceLabel,
  onOpenChange,
  onOpenFile,
}: FileOpenerProps) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const id = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 10);
    return () => window.clearTimeout(id);
  }, [open]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return files;
    }
    return files.filter((path) => path.toLowerCase().includes(normalized));
  }, [files, query]);

  const handleSelect = (path: string) => {
    onOpenFile(path);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0">
        <div className="border-b border-slate-800 px-4 py-3">
          <div className="text-xs uppercase tracking-[0.3em] text-slate-500">
            File opener
          </div>
          {workspaceLabel ? (
            <div className="mt-1 text-xs text-slate-500">{workspaceLabel}</div>
          ) : null}
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search workspace files..."
            className="mt-3"
          />
        </div>
        <div className="max-h-80 overflow-auto p-2">
          {files.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-slate-500">
              Select a workspace to browse files.
            </div>
          ) : (
            <>
              {recentFiles.length > 0 ? (
                <div className="mb-4">
                  <div className="px-3 py-1 text-[10px] uppercase tracking-widest text-slate-500">
                    Recent
                  </div>
                  <div className="mt-1 space-y-1">
                    {recentFiles.map((path) => (
                      <button
                        key={`recent-${path}`}
                        type="button"
                        onClick={() => handleSelect(path)}
                        className="w-full rounded-md px-3 py-2 text-left text-sm text-slate-200 transition hover:bg-slate-900"
                      >
                        {path}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              <div>
                <div className="px-3 py-1 text-[10px] uppercase tracking-widest text-slate-500">
                  Files
                </div>
                <div className="mt-1 space-y-1">
                  {filtered.length === 0 ? (
                    <div className="px-3 py-4 text-sm text-slate-500">
                      No matching files.
                    </div>
                  ) : (
                    filtered.slice(0, 200).map((path) => (
                      <button
                        key={path}
                        type="button"
                        onClick={() => handleSelect(path)}
                        className="w-full rounded-md px-3 py-2 text-left text-sm text-slate-200 transition hover:bg-slate-900"
                      >
                        {path}
                      </button>
                    ))
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
