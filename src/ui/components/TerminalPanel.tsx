import { useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import { Button } from '@/components/ui/button';

type TerminalSession = {
  id: string;
  label: string;
};

type TerminalOutputEvent = {
  terminalId: string;
  data: string;
};

type TerminalPanelProps = {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  onSelect: (terminalId: string) => void;
  onClose: (terminalId: string) => void;
  onCreate: () => void;
  focusToken: number;
};

type TerminalInstance = {
  terminal: Terminal;
  fit: FitAddon;
  opened: boolean;
};

const terminalTheme = {
  background: '#0f172a',
  foreground: '#e2e8f0',
  cursor: '#e2e8f0',
  selectionBackground: 'rgba(148, 163, 184, 0.35)',
};

export default function TerminalPanel({
  sessions,
  activeSessionId,
  onSelect,
  onClose,
  onCreate,
  focusToken,
}: TerminalPanelProps) {
  const instancesRef = useRef<Map<string, TerminalInstance>>(new Map());
  const containersRef = useRef<Map<string, HTMLDivElement>>(new Map());

  const attachTerminal = useCallback((terminalId: string) => {
    const instance = instancesRef.current.get(terminalId);
    const container = containersRef.current.get(terminalId);
    if (!instance || !container || instance.opened) {
      return;
    }
    instance.terminal.open(container);
    instance.opened = true;
    instance.fit.fit();
    void invoke('resizeTerminal', {
      terminalId,
      cols: instance.terminal.cols,
      rows: instance.terminal.rows,
    });
  }, []);

  const fitTerminal = useCallback((terminalId: string) => {
    const instance = instancesRef.current.get(terminalId);
    if (!instance) {
      return;
    }
    instance.fit.fit();
    void invoke('resizeTerminal', {
      terminalId,
      cols: instance.terminal.cols,
      rows: instance.terminal.rows,
    });
  }, []);

  const containerRef = useCallback(
    (terminalId: string) => (element: HTMLDivElement | null) => {
      if (!element) {
        return;
      }
      containersRef.current.set(terminalId, element);
      attachTerminal(terminalId);
    },
    [attachTerminal],
  );

  useEffect(() => {
    for (const session of sessions) {
      if (instancesRef.current.has(session.id)) {
        continue;
      }
      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: 12,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        scrollback: 2000,
        theme: terminalTheme,
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.onData((data) => {
        void invoke('writeTerminal', { terminalId: session.id, data });
      });
      instancesRef.current.set(session.id, { terminal, fit, opened: false });
      attachTerminal(session.id);
    }
    for (const [terminalId, instance] of instancesRef.current.entries()) {
      if (sessions.some((session) => session.id === terminalId)) {
        continue;
      }
      instance.terminal.dispose();
      instancesRef.current.delete(terminalId);
      containersRef.current.delete(terminalId);
    }
  }, [attachTerminal, sessions]);

  useEffect(() => {
    if (!activeSessionId && sessions[0]) {
      onSelect(sessions[0].id);
    }
  }, [activeSessionId, onSelect, sessions]);

  useEffect(() => {
    const unlisten = listen<TerminalOutputEvent>('terminal-output', (event) => {
      const { terminalId, data } = event.payload;
      const instance = instancesRef.current.get(terminalId);
      if (!instance) {
        return;
      }
      instance.terminal.write(data);
    });
    return () => {
      void unlisten.then((cleanup) => cleanup());
    };
  }, []);

  useEffect(() => {
    const instances = instancesRef.current;
    const containers = containersRef.current;
    return () => {
      for (const instance of instances.values()) {
        instance.terminal.dispose();
      }
      instances.clear();
      containers.clear();
    };
  }, []);

  useEffect(() => {
    if (!activeSessionId) {
      return;
    }
    const container = containersRef.current.get(activeSessionId);
    if (!container) {
      return;
    }
    const observer = new ResizeObserver(() => {
      fitTerminal(activeSessionId);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [activeSessionId, fitTerminal]);

  useEffect(() => {
    if (!activeSessionId) {
      return;
    }
    const instance = instancesRef.current.get(activeSessionId);
    if (!instance) {
      return;
    }
    instance.terminal.focus();
    fitTerminal(activeSessionId);
  }, [activeSessionId, fitTerminal, focusToken]);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap gap-2">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              onClick={() => onSelect(session.id)}
              className={`flex items-center gap-2 rounded-md px-2 py-1 text-xs transition ${
                session.id === activeSessionId
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100'
              }`}
            >
              <span className="truncate">{session.label}</span>
              <span
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(session.id);
                }}
                className="text-[10px] text-slate-500 hover:text-slate-100"
              >
                x
              </span>
            </button>
          ))}
        </div>
        <Button size="sm" variant="outline" onClick={onCreate}>
          + Terminal
        </Button>
      </div>

      <div className="relative h-48 rounded-md border border-slate-800 bg-slate-950/60">
        {sessions.length === 0 ? (
          <div className="p-3 text-xs text-slate-500">
            No terminals yet. Create one to start.
          </div>
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              ref={containerRef(session.id)}
              className={`absolute inset-0 ${
                session.id === activeSessionId ? 'block' : 'hidden'
              }`}
            />
          ))
        )}
      </div>
    </div>
  );
}
