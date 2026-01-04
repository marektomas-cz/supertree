import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

export type CommandPaletteItem = {
  id: string;
  label: string;
  description?: string;
  group: string;
  keywords?: string[];
  onSelect: () => void;
};

type CommandPaletteProps = {
  open: boolean;
  items: CommandPaletteItem[];
  onOpenChange: (open: boolean) => void;
};

const normalize = (value: string) => value.toLowerCase();

export default function CommandPalette({
  open,
  items,
  onOpenChange,
}: CommandPaletteProps) {
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
    const normalized = normalize(query.trim());
    if (!normalized) {
      return items;
    }
    return items.filter((item) => {
      const base = `${item.label} ${item.description ?? ''} ${item.group}`;
      const haystack = `${base} ${(item.keywords ?? []).join(' ')}`.toLowerCase();
      return haystack.includes(normalized);
    });
  }, [items, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, CommandPaletteItem[]>();
    filtered.forEach((item) => {
      const list = map.get(item.group) ?? [];
      list.push(item);
      map.set(item.group, list);
    });
    return Array.from(map.entries());
  }, [filtered]);

  const handleSelect = (item: CommandPaletteItem) => {
    item.onSelect();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0">
        <div className="border-b border-slate-800 px-4 py-3">
          <div className="text-xs uppercase tracking-[0.3em] text-slate-500">
            Command palette
          </div>
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search commands, workspaces, and settings..."
            className="mt-3"
          />
        </div>
        <div className="max-h-80 overflow-auto p-2">
          {grouped.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-slate-500">
              No matches found.
            </div>
          ) : (
            grouped.map(([group, groupItems]) => (
              <div key={group} className="mb-3 last:mb-0">
                <div className="px-3 py-1 text-[10px] uppercase tracking-widest text-slate-500">
                  {group}
                </div>
                <div className="mt-1 space-y-1">
                  {groupItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleSelect(item)}
                      className="flex w-full flex-col gap-1 rounded-md px-3 py-2 text-left text-sm text-slate-200 transition hover:bg-slate-900"
                    >
                      <span>{item.label}</span>
                      {item.description ? (
                        <span className="text-xs text-slate-500">{item.description}</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
