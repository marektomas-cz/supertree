import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';

type AppPaths = {
  appDataDir: string;
  logsDir: string;
  workspacesDir: string;
  toolsDir: string;
  dbPath: string;
};

type AppInfo = {
  version: string;
  paths: AppPaths;
};

type SettingEntry = {
  key: string;
  value: string;
};

const sections = [
  'General',
  'Account',
  'Git',
  'Env',
  'Terminal',
  'MCP',
  'Commands',
  'Agents',
  'Memory',
  'Hooks',
  'Experimental',
];

/**
 * Settings view with Env editor and app path diagnostics.
 */
export default function SettingsPage() {
  const [activeSection, setActiveSection] = useState('Env');
  const [envVars, setEnvVars] = useState('');
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const saveTimeoutRef = useRef<number | null>(null);
  const [spotlightEnabled, setSpotlightEnabled] = useState(false);
  const [spotlightState, setSpotlightState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [spotlightError, setSpotlightError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const [envResult, infoResult, settingsResult] = await Promise.allSettled([
        invoke<string>('getEnvVars'),
        invoke<AppInfo>('getAppInfo'),
        invoke<SettingEntry[]>('listSettings'),
      ]);

      if (!active) {
        return;
      }

      const errors: string[] = [];

      if (envResult.status === 'fulfilled') {
        setEnvVars(envResult.value ?? '');
      } else {
        errors.push(String(envResult.reason));
      }

      if (infoResult.status === 'fulfilled') {
        setAppInfo(infoResult.value);
      } else {
        errors.push(String(infoResult.reason));
      }

      if (settingsResult.status === 'fulfilled') {
        const byKey = new Map(settingsResult.value.map((item) => [item.key, item.value]));
        setSpotlightEnabled(byKey.get('spotlight_enabled') === 'true');
      } else {
        setSpotlightError(String(settingsResult.reason));
      }

      setError(errors.length > 0 ? errors.join(' | ') : null);
    };

    load();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current !== null) {
        window.clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  const saveLabel = useMemo(() => {
    switch (saveState) {
      case 'saving':
        return 'Saving...';
      case 'saved':
        return 'Saved';
      case 'error':
        return 'Retry save';
      default:
        return 'Save';
    }
  }, [saveState]);

  const experimentalLabel = useMemo(() => {
    switch (spotlightState) {
      case 'saving':
        return 'Saving...';
      case 'error':
        return 'Retry';
      default:
        return spotlightEnabled ? 'Enabled' : 'Disabled';
    }
  }, [spotlightEnabled, spotlightState]);

  const handleSave = async () => {
    setSaveState('saving');
    setError(null);
    try {
      await invoke('setEnvVars', { value: envVars });
      setSaveState('saved');
      if (saveTimeoutRef.current !== null) {
        window.clearTimeout(saveTimeoutRef.current);
      }
      saveTimeoutRef.current = window.setTimeout(() => {
        setSaveState('idle');
        saveTimeoutRef.current = null;
      }, 1500);
    } catch (err) {
      setSaveState('error');
      setError(String(err));
    }
  };

  const handleToggleSpotlight = async () => {
    const next = !spotlightEnabled;
    setSpotlightState('saving');
    setSpotlightError(null);
    try {
      await invoke('setSetting', {
        key: 'spotlight_enabled',
        value: next ? 'true' : 'false',
      });
      setSpotlightEnabled(next);
      setSpotlightState('idle');
      window.dispatchEvent(new Event('supertree-settings-updated'));
    } catch (err) {
      setSpotlightState('error');
      setSpotlightError(String(err));
    }
  };

  const isSectionEnabled = useMemo(
    () => (section: string) => section === 'Env' || section === 'Experimental',
    [],
  );
  const headerDescription =
    activeSection === 'Experimental'
      ? 'Turn on experimental features and preview upcoming workflows.'
      : 'Configure environment variables and verify local app paths.';

  return (
    <div className="flex h-full gap-6">
      <nav className="w-48 shrink-0 border-r border-slate-800 pr-4">
        <div className="text-xs uppercase tracking-[0.3em] text-slate-500">
          Settings
        </div>
        <div className="mt-4 flex flex-col gap-1">
          {sections.map((section) => (
            <button
              key={section}
              type="button"
              disabled={!isSectionEnabled(section)}
              onClick={() => {
                if (isSectionEnabled(section)) {
                  setActiveSection(section);
                }
              }}
              className={`rounded-md px-3 py-2 text-left text-sm transition ${
                activeSection === section
                  ? 'bg-slate-800 text-slate-100'
                  : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
              } ${!isSectionEnabled(section) ? 'cursor-not-allowed text-slate-600 hover:bg-transparent hover:text-slate-600' : ''}`}
            >
              {section}
            </button>
          ))}
        </div>
      </nav>

      <section className="flex-1 space-y-8">
        <header>
          <h1 className="text-2xl font-semibold">Settings</h1>
          <p className="mt-2 text-sm text-slate-400">
            {headerDescription}
          </p>
        </header>

        {activeSection === 'Experimental' ? (
          <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-5">
            <div className="text-xs uppercase tracking-widest text-slate-500">
              Experimental
            </div>
            <div className="mt-4 flex flex-wrap items-start justify-between gap-4 text-sm text-slate-200">
              <div className="space-y-2">
                <div className="text-sm font-semibold text-slate-100">Spotlight sync</div>
                <div className="text-xs text-slate-400">
                  Mirror workspace changes into the repo root for fast testing. Use the
                  Spotlight button inside a workspace to toggle it.
                </div>
                <div className="text-xs text-slate-500">
                  Windows support is experimental.
                </div>
              </div>
              <label className="flex items-center gap-3 text-xs text-slate-400">
                <input
                  type="checkbox"
                  checked={spotlightEnabled}
                  onChange={handleToggleSpotlight}
                  disabled={spotlightState === 'saving'}
                  className="h-4 w-4 rounded border-slate-700 bg-slate-950"
                />
                <span>{experimentalLabel}</span>
              </label>
            </div>
            {spotlightError ? (
              <div className="mt-3 text-xs text-red-400">{spotlightError}</div>
            ) : null}
          </div>
        ) : (
          <>
            <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-5">
              <div className="text-xs uppercase tracking-widest text-slate-500">
                Env
              </div>
              <p className="mt-2 text-sm text-slate-400">
                Paste one variable per line, for example{' '}
                <span className="text-slate-200">KEY=value</span>.
              </p>
              <textarea
                className="mt-4 h-40 w-full resize-none rounded-md border border-slate-800 bg-slate-950 p-3 text-sm text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                value={envVars}
                onChange={(event) => setEnvVars(event.target.value)}
                spellCheck={false}
              />
              <div className="mt-4 flex items-center gap-3">
                <Button onClick={handleSave} disabled={saveState === 'saving'}>
                  {saveLabel}
                </Button>
                {error ? (
                  <span className="text-sm text-red-400">{error}</span>
                ) : null}
              </div>
            </div>

            <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-5">
              <div className="text-xs uppercase tracking-widest text-slate-500">
                App info
              </div>
              {appInfo ? (
                <div className="mt-4 grid gap-2 text-sm text-slate-300">
                  <div>
                    <span className="text-slate-500">Version:</span> {appInfo.version}
                  </div>
                  <div>
                    <span className="text-slate-500">App data:</span> {appInfo.paths.appDataDir}
                  </div>
                  <div>
                    <span className="text-slate-500">Logs:</span> {appInfo.paths.logsDir}
                  </div>
                  <div>
                    <span className="text-slate-500">Workspaces:</span> {appInfo.paths.workspacesDir}
                  </div>
                  <div>
                    <span className="text-slate-500">Tools:</span> {appInfo.paths.toolsDir}
                  </div>
                  <div>
                    <span className="text-slate-500">Database:</span> {appInfo.paths.dbPath}
                  </div>
                </div>
              ) : (
                <div className="mt-4 text-sm text-slate-500">Loading app info...</div>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
