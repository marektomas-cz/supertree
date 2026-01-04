import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import CommandPalette, { type CommandPaletteItem } from '@/components/CommandPalette';
import FileOpener from '@/components/FileOpener';
import TerminalPanel from '@/components/TerminalPanel';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { formatGreeting } from '@/lib/format';
import type { OpenTarget, RepoInfo } from '@/types/repo';
import type {
  AskUserQuestionEvent,
  AttachmentRecord,
  ExitPlanModeEvent,
  SessionErrorEvent,
  SessionMessageEvent,
  SessionMessageRecord,
  SessionPlanModeEvent,
  SessionRecord,
  SessionStatusEvent,
} from '@/types/session';
import type { FilePreview, WorkspaceInfo } from '@/types/workspace';
import RepositoryPage from './RepositoryPage';
import SettingsPage from './SettingsPage';
import WorkspacesPage from './WorkspacesPage';

type SessionMessageItem = {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  turnId?: number;
  sentAt?: string | null;
  cancelledAt?: string | null;
  metadata?: Record<string, unknown> | null;
  checkpointId?: string | null;
  streaming?: boolean;
};

type ComposerSuggestion = {
  id: string;
  label: string;
  value: string;
  mode: 'slash' | 'mention';
  description?: string;
};

type RunOutputEvent = {
  workspaceId: string;
  stream: 'stdout' | 'stderr';
  line: string;
};

type RunExitEvent = {
  workspaceId: string;
  code: number | null;
};

type TerminalExitEvent = {
  terminalId: string;
};

type RunOutputEntry = {
  id: string;
  stream: 'stdout' | 'stderr';
  line: string;
};

type TerminalSession = {
  id: string;
  label: string;
};

type GitStatusEntry = {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  additions: number | null;
  deletions: number | null;
};

type SettingsEntry = {
  key: string;
  value: string;
};

type WorkspaceDiffResponse = {
  diff: string;
};

type GithubAuthStatus = {
  available: boolean;
  authenticated: boolean;
  message?: string | null;
};

type PullRequestInfo = {
  number: number;
  url: string;
  baseBranch: string;
  headBranch: string;
};

type PullRequestCheck = {
  name: string;
  status?: string | null;
  conclusion?: string | null;
  detailsUrl?: string | null;
};

type PullRequestCheckSummary = {
  total: number;
  failed: number;
  pending: number;
  success: number;
};

type PullRequestStatus = {
  number: number;
  url: string;
  baseBranch: string;
  headBranch: string;
  reviewDecision?: string | null;
  mergeable?: string | null;
  state?: string | null;
  checks: PullRequestCheckSummary;
  failingChecks: PullRequestCheck[];
};

type PullRequestCommentsResult = {
  content: string;
  newComments: boolean;
};

type FileTreeNode = {
  name: string;
  path: string;
  children?: FileTreeNode[];
  isFile: boolean;
};

const STORAGE_KEYS = {
  leftVisible: 'supertree.leftSidebarVisible',
  rightVisible: 'supertree.rightSidebarVisible',
  leftWidth: 'supertree.leftSidebarWidth',
  rightWidth: 'supertree.rightSidebarWidth',
  zenMode: 'supertree.zenMode',
  openSessions: 'supertree.openSessionsByWorkspace',
  activeSessions: 'supertree.activeSessionsByWorkspace',
};

const REVIEW_DIFF_MAX_CHARS = 12_000;
const REVIEW_DIFF_HEAD_CHARS = 7_000;
const REVIEW_DIFF_TAIL_CHARS = 3_000;

const readBoolean = (key: string, fallback: boolean) => {
  if (typeof window === 'undefined') {
    return fallback;
  }
  const value = window.localStorage.getItem(key);
  if (value === null) {
    return fallback;
  }
  return value === 'true';
};

const readNumber = (key: string, fallback: number) => {
  if (typeof window === 'undefined') {
    return fallback;
  }
  const value = window.localStorage.getItem(key);
  if (value === null) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const readJson = <T,>(key: string, fallback: T): T => {
  if (typeof window === 'undefined') {
    return fallback;
  }
  const value = window.localStorage.getItem(key);
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const truncateReviewDiff = (diff: string) => {
  if (diff.length <= REVIEW_DIFF_MAX_CHARS) {
    return { text: diff, truncated: false };
  }
  const headSection = diff.slice(0, REVIEW_DIFF_HEAD_CHARS);
  const headBoundary = Math.max(
    headSection.lastIndexOf('\ndiff --git'),
    headSection.lastIndexOf('\n@@'),
  );
  const head = headBoundary > 0 ? headSection.slice(0, headBoundary) : headSection;

  const tailSection = diff.slice(-REVIEW_DIFF_TAIL_CHARS);
  const tailBoundaryGit = tailSection.indexOf('\ndiff --git');
  const tailBoundaryHunk = tailSection.indexOf('\n@@');
  let tailBoundary = -1;
  if (tailBoundaryGit >= 0 && tailBoundaryHunk >= 0) {
    tailBoundary = Math.min(tailBoundaryGit, tailBoundaryHunk);
  } else {
    tailBoundary = tailBoundaryGit >= 0 ? tailBoundaryGit : tailBoundaryHunk;
  }
  const tail = tailBoundary > 0 ? tailSection.slice(tailBoundary) : tailSection;
  return { text: `${head}\n...[truncated]...\n${tail}`, truncated: true };
};

const buildFileTree = (files: string[]): FileTreeNode[] => {
  type FileTreeMapNode = {
    name: string;
    path: string;
    children: Record<string, FileTreeMapNode>;
    isFile: boolean;
  };
  const root: Record<string, FileTreeMapNode> = {};
  for (const file of files) {
    const parts = file.split('/').filter(Boolean);
    let current = root;
    let currentPath = '';
    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!current[part]) {
        current[part] = {
          name: part,
          path: currentPath,
          children: {},
          isFile: index === parts.length - 1,
        };
      }
      if (index < parts.length - 1) {
        current[part].isFile = false;
      } else if (Object.keys(current[part].children).length === 0) {
        current[part].isFile = true;
      }
      current = current[part].children;
    });
  }

  const toArray = (nodeMap: Record<string, FileTreeMapNode>): FileTreeNode[] => {
    return Object.values(nodeMap)
      .map((node) => {
        const children = Object.keys(node.children).length > 0 ? toArray(node.children) : undefined;
        return { name: node.name, path: node.path, children, isFile: node.isFile };
      })
      .sort((a, b) => {
        if (a.isFile !== b.isFile) {
          return a.isFile ? 1 : -1;
        }
        return a.name.localeCompare(b.name);
      });
  };

  return toArray(root);
};

const GIT_STATUS_LABELS: Record<string, string> = {
  '?': 'Untracked',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  M: 'Modified',
};

const formatGitStatus = (entry: GitStatusEntry) => {
  const index = entry.indexStatus.trim();
  const worktree = entry.worktreeStatus.trim();
  if (index === '?' && worktree === '?') {
    return GIT_STATUS_LABELS['?'];
  }
  return GIT_STATUS_LABELS[index] ?? GIT_STATUS_LABELS[worktree] ?? 'Updated';
};

const writeJson = (key: string, value: unknown) => {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(key, JSON.stringify(value));
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const createRunOutputEntry = (
  stream: RunOutputEntry['stream'],
  line: string,
): RunOutputEntry => {
  const cryptoObj = globalThis.crypto;
  const id =
    typeof cryptoObj?.randomUUID === 'function'
      ? cryptoObj.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return { id, stream, line };
};

const parseMetadataJson = (value?: string | null) => {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const normalizeSessionMessage = (
  message: SessionMessageRecord,
): SessionMessageItem => ({
  id: message.id,
  sessionId: message.sessionId,
  role: message.role,
  content: message.content,
  turnId: message.turnId,
  sentAt: message.sentAt ?? null,
  cancelledAt: message.cancelledAt ?? null,
  metadata: parseMetadataJson(message.metadataJson),
  checkpointId: message.checkpointId ?? null,
  streaming: false,
});

const formatAgentLabel = (agentType: SessionRecord['agentType']) => {
  if (agentType === 'codex') {
    return 'Codex';
  }
  if (agentType === 'claude') {
    return 'Claude';
  }
  return 'Unknown';
};

const MODEL_GROUPS = [
  {
    id: 'claude',
    label: 'Claude Code',
    models: [
      { id: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet' },
      { id: 'claude-3-5-haiku', label: 'Claude 3.5 Haiku' },
      { id: 'claude-3-opus', label: 'Claude 3 Opus' },
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    models: [
      { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
      { id: 'gpt-4.1-codex', label: 'GPT-4.1 Codex' },
    ],
  },
] as const;

const CONTEXT_LIMITS: Record<'claude' | 'codex', number> = {
  claude: 200_000,
  codex: 128_000,
};

const COMMANDS_PREFIX = '.claude/commands/';

const MODEL_LOOKUP = (() => {
  const agentById = new Map<string, 'claude' | 'codex'>();
  const labelById = new Map<string, string>();
  for (const group of MODEL_GROUPS) {
    for (const model of group.models) {
      agentById.set(model.id, group.id);
      labelById.set(model.id, model.label);
    }
  }
  return { agentById, labelById };
})();

const getDefaultModel = (agentType: 'claude' | 'codex') => {
  const group = MODEL_GROUPS.find((item) => item.id === agentType);
  return group?.models[0]?.id ?? null;
};

const getModelLabel = (modelId?: string | null) =>
  modelId ? MODEL_LOOKUP.labelById.get(modelId) ?? modelId : null;

type MarkdownChunk =
  | { type: 'text'; content: string }
  | { type: 'code'; content: string; language?: string };

const splitMarkdown = (input: string): MarkdownChunk[] => {
  const chunks: MarkdownChunk[] = [];
  const pattern = /```([^\n]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    if (match.index > lastIndex) {
      chunks.push({ type: 'text', content: input.slice(lastIndex, match.index) });
    }
    const language = match[1]?.trim() || undefined;
    chunks.push({ type: 'code', content: match[2] ?? '', language });
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < input.length) {
    chunks.push({ type: 'text', content: input.slice(lastIndex) });
  }
  return chunks;
};

const renderMentions = (
  text: string,
  fileSet: Set<string>,
  onMentionClick: (path: string) => void,
) => {
  const tokens: Array<string | JSX.Element> = [];
  const mentionRegex = /@([A-Za-z0-9._/\\-]+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push(text.slice(lastIndex, match.index));
    }
    const full = match[0];
    const path = match[1];
    if (fileSet.has(path)) {
      tokens.push(
        <button
          key={`${path}-${match.index}`}
          type="button"
          onClick={() => onMentionClick(path)}
          className="rounded border border-slate-800 px-1 text-xs text-slate-200 hover:bg-slate-900"
        >
          {full}
        </button>,
      );
    } else {
      tokens.push(full);
    }
    lastIndex = match.index + full.length;
  }
  if (lastIndex < text.length) {
    tokens.push(text.slice(lastIndex));
  }
  return tokens;
};

const renderInlineMarkdown = (
  text: string,
  fileSet: Set<string>,
  onMentionClick: (path: string) => void,
) => {
  if (!text) {
    return null;
  }
  const parts = text.split(/`([^`]+)`/g);
  return parts.map((part, index) => {
    if (index % 2 === 1) {
      return (
        <code
          key={`inline-${index}`}
          className="rounded bg-slate-900 px-1 py-0.5 text-xs text-slate-100"
        >
          {part}
        </code>
      );
    }
    const mentions = renderMentions(part, fileSet, onMentionClick);
    return <span key={`text-${index}`}>{mentions}</span>;
  });
};

const renderMarkdownContent = (
  content: string,
  fileSet: Set<string>,
  onMentionClick: (path: string) => void,
) => {
  const chunks = splitMarkdown(content);
  return chunks.map((chunk, index) => {
    if (chunk.type === 'code') {
      return (
        <pre
          key={`code-${index}`}
          className="mt-3 overflow-auto rounded-md border border-slate-800 bg-slate-950 p-3 text-xs text-slate-100"
        >
          <code>{chunk.content}</code>
        </pre>
      );
    }
    return (
      <div key={`text-${index}`} className="whitespace-pre-wrap text-sm text-slate-100">
        {renderInlineMarkdown(chunk.content, fileSet, onMentionClick)}
      </div>
    );
  });
};

const RUN_OUTPUT_LIMIT = 400;

/**
 * Top-level shell layout with left navigation and main content area.
 */
export default function AppShell() {
  const [activeView, setActiveView] = useState<
    'home' | 'settings' | 'repo' | 'workspaces' | 'workspace'
  >('home');
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
  const historyRef = useRef<HTMLDivElement>(null);
  const linkIssueRef = useRef<HTMLDivElement>(null);
  const newChatRef = useRef<HTMLDivElement>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [workspaceMenuId, setWorkspaceMenuId] = useState<string | null>(null);
  const workspaceMenuRefs = useRef<Record<string, HTMLDivElement | null>>({});
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
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const [archiveConfirmWorkspace, setArchiveConfirmWorkspace] = useState<WorkspaceInfo | null>(
    null,
  );
  const [archiveConfirmScript, setArchiveConfirmScript] = useState<string | null>(null);
  const archiveConfirmRef = useRef<HTMLDivElement>(null);
  const askUserRef = useRef<HTMLDivElement>(null);
  const exitPlanRef = useRef<HTMLDivElement>(null);
  const [leftSidebarVisible, setLeftSidebarVisible] = useState(() =>
    readBoolean(STORAGE_KEYS.leftVisible, true),
  );
  const [rightSidebarVisible, setRightSidebarVisible] = useState(() =>
    readBoolean(STORAGE_KEYS.rightVisible, true),
  );
  const [zenMode, setZenMode] = useState(() =>
    readBoolean(STORAGE_KEYS.zenMode, false),
  );
  const [leftSidebarWidth, setLeftSidebarWidth] = useState(() =>
    readNumber(STORAGE_KEYS.leftWidth, 280),
  );
  const [rightSidebarWidth, setRightSidebarWidth] = useState(() =>
    readNumber(STORAGE_KEYS.rightWidth, 320),
  );
  const leftResizeState = useRef<{ startX: number; startWidth: number } | null>(null);
  const rightResizeState = useRef<{ startX: number; startWidth: number } | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [fileOpenerOpen, setFileOpenerOpen] = useState(false);
  const [fileListError, setFileListError] = useState<string | null>(null);
  const [filePreviewError, setFilePreviewError] = useState<string | null>(null);
  const [filesByWorkspace, setFilesByWorkspace] = useState<Record<string, string[]>>({});
  const [recentFilesByWorkspace, setRecentFilesByWorkspace] = useState<
    Record<string, string[]>
  >({});
  const [filePreviewByWorkspace, setFilePreviewByWorkspace] = useState<
    Record<string, FilePreview | null>
  >({});
  const [sessionsByWorkspace, setSessionsByWorkspace] = useState<
    Record<string, SessionRecord[]>
  >({});
  const [openSessionIdsByWorkspace, setOpenSessionIdsByWorkspace] = useState<
    Record<string, string[]>
  >(() => readJson(STORAGE_KEYS.openSessions, {}));
  const [closedSessionIdsByWorkspace, setClosedSessionIdsByWorkspace] = useState<
    Record<string, string[]>
  >({});
  const [messagesBySession, setMessagesBySession] = useState<
    Record<string, SessionMessageItem[]>
  >({});
  const [attachmentsBySession, setAttachmentsBySession] = useState<
    Record<string, AttachmentRecord[]>
  >({});
  const [draftAttachmentsBySession, setDraftAttachmentsBySession] = useState<
    Record<string, AttachmentRecord[]>
  >({});
  const [sessionErrors, setSessionErrors] = useState<
    Record<string, string | null>
  >({});
  const [sessionStatuses, setSessionStatuses] = useState<
    Record<string, SessionRecord['status']>
  >({});
  const [planModeBySession, setPlanModeBySession] = useState<
    Record<string, boolean>
  >({});
  const [permissionModeBySession, setPermissionModeBySession] = useState<       
    Record<string, string>
  >({});
  const [gitStatusByWorkspace, setGitStatusByWorkspace] = useState<
    Record<string, GitStatusEntry[]>
  >({});
  const [gitStatusErrorByWorkspace, setGitStatusErrorByWorkspace] = useState<
    Record<string, string | null>
  >({});
  const [gitStatusLoadingByWorkspace, setGitStatusLoadingByWorkspace] = useState<
    Record<string, boolean>
  >({});
  const [workspaceDiffByWorkspace, setWorkspaceDiffByWorkspace] = useState<
    Record<string, string>
  >({});
  const [workspaceDiffErrorByWorkspace, setWorkspaceDiffErrorByWorkspace] =
    useState<Record<string, string | null>>({});
  const [diffLoadingByWorkspace, setDiffLoadingByWorkspace] = useState<
    Record<string, boolean>
  >({});
  const [selectedDiffPathByWorkspace, setSelectedDiffPathByWorkspace] = useState<
    Record<string, string | null>
  >({});
  const [diffHistoryExpandedByMessage, setDiffHistoryExpandedByMessage] =
    useState<Record<string, boolean>>({});
  const [githubAuthStatus, setGithubAuthStatus] =
    useState<GithubAuthStatus | null>(null);
  const [githubAuthLoading, setGithubAuthLoading] = useState(false);
  const [repoBranchesByRepoId, setRepoBranchesByRepoId] = useState<
    Record<string, string[]>
  >({});
  const [pullRequestStatusByWorkspace, setPullRequestStatusByWorkspace] =
    useState<Record<string, PullRequestStatus | null>>({});
  const [pullRequestStatusErrorByWorkspace, setPullRequestStatusErrorByWorkspace] =
    useState<Record<string, string | null>>({});
  const [pullRequestStatusLoadingByWorkspace, setPullRequestStatusLoadingByWorkspace] =
    useState<Record<string, boolean>>({});
  const [pullRequestActionErrorByWorkspace, setPullRequestActionErrorByWorkspace] =
    useState<Record<string, string | null>>({});
  const [pullRequestActionLoadingByWorkspace, setPullRequestActionLoadingByWorkspace] =
    useState<Record<string, boolean>>({});
  const [reviewModel, setReviewModel] = useState<string | null>(null);
  const [reviewThinkingLevel, setReviewThinkingLevel] = useState<string | null>(
    null,
  );
  const [composerValue, setComposerValue] = useState('');
  const [composerDragActive, setComposerDragActive] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const [composerSuggestions, setComposerSuggestions] = useState<ComposerSuggestion[]>([]);
  const [composerSuggestionIndex, setComposerSuggestionIndex] = useState(0);
  const [composerSuggestionRange, setComposerSuggestionRange] = useState<{
    start: number;
    end: number;
  } | null>(null);
  const [newChatAgentType, setNewChatAgentType] = useState<'claude' | 'codex'>(
    'claude',
  );
  const [newChatModelByAgent, setNewChatModelByAgent] = useState<
    Record<'claude' | 'codex', string | null>
  >({ claude: null, codex: null });
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [newChatContextIds, setNewChatContextIds] = useState<string[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [linkIssueOpen, setLinkIssueOpen] = useState(false);
  const [linkIssueValue, setLinkIssueValue] = useState('');
  // Link issue state is UI-only by design for M07.
  const [linkedIssueBySession, setLinkedIssueBySession] = useState<
    Record<string, string>
  >({});
  const [pendingIssueId, setPendingIssueId] = useState<string | null>(null);
  const [sessionListError, setSessionListError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [resettingTurnId, setResettingTurnId] = useState<number | null>(null);
  const [pendingAskQueue, setPendingAskQueue] = useState<AskUserQuestionEvent[]>(
    [],
  );
  const [pendingExitQueue, setPendingExitQueue] = useState<ExitPlanModeEvent[]>(
    [],
  );
  const [askAnswers, setAskAnswers] = useState<string[]>([]);
  const [activeSessionByWorkspace, setActiveSessionByWorkspace] = useState<
    Record<string, string | null>
  >(() => readJson(STORAGE_KEYS.activeSessions, {}));
  const [activeTabByWorkspace, setActiveTabByWorkspace] = useState<
    Record<string, 'changes' | 'session'>
  >({});
  const [rightPanelTab, setRightPanelTab] = useState<'run' | 'terminal'>('run');
  const [gitPanelTab, setGitPanelTab] = useState<'changes' | 'files'>('changes');
  const [runStatusByWorkspace, setRunStatusByWorkspace] = useState<
    Record<string, 'idle' | 'running'>
  >({});
  const [runOutputByWorkspace, setRunOutputByWorkspace] = useState<
    Record<string, RunOutputEntry[]>
  >({});
  const [runErrorByWorkspace, setRunErrorByWorkspace] = useState<
    Record<string, string | null>
  >({});
  const [terminalErrorByWorkspace, setTerminalErrorByWorkspace] = useState<
    Record<string, string | null>
  >({});
  const [terminalSessionsByWorkspace, setTerminalSessionsByWorkspace] = useState<
    Record<string, TerminalSession[]>
  >({});
  const [activeTerminalByWorkspace, setActiveTerminalByWorkspace] = useState<
    Record<string, string | null>
  >({});
  const [terminalFocusToken, setTerminalFocusToken] = useState(0);
  const [fileListVisibleCount, setFileListVisibleCount] = useState(20);

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
  const runScript = selectedWorkspaceRepo?.scriptsRun?.trim() ?? null;
  const activeWorkspaceId = selectedWorkspace?.id ?? null;
  const activeSessions = useMemo(() => {
    if (!activeWorkspaceId) {
      return [];
    }
    const sessions = sessionsByWorkspace[activeWorkspaceId] ?? [];
    const openIds = openSessionIdsByWorkspace[activeWorkspaceId] ?? [];
    if (openIds.length === 0) {
      return sessions;
    }
    const byId = new Map(sessions.map((session) => [session.id, session]));
    return openIds
      .map((id) => byId.get(id))
      .filter((session): session is SessionRecord => Boolean(session));
  }, [activeWorkspaceId, openSessionIdsByWorkspace, sessionsByWorkspace]);
  const activeSessionId = useMemo(() => {
    if (!activeWorkspaceId) {
      return null;
    }
    const activeId = activeSessionByWorkspace[activeWorkspaceId] ?? null;
    const openIds = openSessionIdsByWorkspace[activeWorkspaceId] ?? [];
    if (activeId && openIds.includes(activeId)) {
      return activeId;
    }
    return openIds.length > 0 ? openIds[openIds.length - 1] : null;
  }, [activeSessionByWorkspace, activeWorkspaceId, openSessionIdsByWorkspace]);
  const activeSession = useMemo(() => {
    if (!activeSessionId) {
      return null;
    }
    return activeSessions.find((session) => session.id === activeSessionId) ?? null;
  }, [activeSessionId, activeSessions]);
  const activeSessionStatus = useMemo(() => {
    if (!activeSession) {
      return 'idle';
    }
    return sessionStatuses[activeSession.id] ?? activeSession.status ?? 'idle';
  }, [activeSession, sessionStatuses]);
  const activeWorkspaceSessions = useMemo(() => {
    if (!activeWorkspaceId) {
      return [];
    }
    return sessionsByWorkspace[activeWorkspaceId] ?? [];
  }, [activeWorkspaceId, sessionsByWorkspace]);
  const hasAnyRunningSessions = useMemo(() => {
    if (activeSessionStatus === 'running') {
      return true;
    }
    return activeWorkspaceSessions.some((session) => {
      const status = sessionStatuses[session.id] ?? session.status ?? 'idle';
      return status === 'running' && session.id !== activeSessionId;
    });
  }, [
    activeSessionId,
    activeSessionStatus,
    activeWorkspaceSessions,
    sessionStatuses,
  ]);
  const activeSessionMessages = useMemo(() => {
    if (!activeSessionId) {
      return [];
    }
    return messagesBySession[activeSessionId] ?? [];
  }, [activeSessionId, messagesBySession]);
  const activeSessionAttachments = useMemo(() => {
    if (!activeSessionId) {
      return [];
    }
    return attachmentsBySession[activeSessionId] ?? [];
  }, [activeSessionId, attachmentsBySession]);
  const activeDraftAttachments = useMemo(() => {
    if (!activeSessionId) {
      return [];
    }
    return draftAttachmentsBySession[activeSessionId] ?? [];
  }, [activeSessionId, draftAttachmentsBySession]);
  const activeSessionError = activeSessionId
    ? sessionErrors[activeSessionId] ?? null
    : null;
  const activePlanMode = activeSessionId
    ? planModeBySession[activeSessionId] ?? false
    : false;
  const activePermissionMode = activeSessionId
    ? permissionModeBySession[activeSessionId] ?? 'default'
    : 'default';
  const contextUsagePercent = useMemo(() => {
    if (!activeSession) {
      return null;
    }
    const agentType = activeSession.agentType === 'codex' ? 'codex' : 'claude';
    const limit = CONTEXT_LIMITS[agentType] ?? 0;
    const count = activeSession.contextTokenCount ?? 0;
    if (limit === 0) {
      return null;
    }
    return Math.min(100, Math.round((count / limit) * 100));
  }, [activeSession]);
  const selectedModelId = useMemo(() => {
    if (activeSession) {
      return (
        activeSession.model ??
        getDefaultModel(activeSession.agentType === 'codex' ? 'codex' : 'claude')
      );
    }
    return (
      newChatModelByAgent[newChatAgentType] ??
      getDefaultModel(newChatAgentType)
    );
  }, [activeSession, newChatAgentType, newChatModelByAgent]);
  const modelGroupsForSelection = useMemo(() => MODEL_GROUPS, []);
  const canSendMessage =
    Boolean(activeWorkspaceId) &&
    composerValue.trim().length > 0 &&
    activeSessionStatus !== 'running';
  const canCancelSession = Boolean(activeSession) && activeSessionStatus === 'running';
  const activeAskRequest = pendingAskQueue[0] ?? null;
  const activeExitRequest = pendingExitQueue[0] ?? null;
  const activeTab = useMemo(() => {
    if (!activeWorkspaceId) {
      return 'changes';
    }
    return activeTabByWorkspace[activeWorkspaceId] ?? 'changes';
  }, [activeTabByWorkspace, activeWorkspaceId]);
  const workspaceFiles = useMemo(() => {
    if (!activeWorkspaceId) {
      return [];
    }
    return filesByWorkspace[activeWorkspaceId] ?? [];
  }, [activeWorkspaceId, filesByWorkspace]);
  const workspaceFileSet = useMemo(
    () => new Set(workspaceFiles),
    [workspaceFiles],
  );
  const slashCommands = useMemo(() => {
    return workspaceFiles
      .filter((path) => path.startsWith(COMMANDS_PREFIX))
      .map((path) => path.slice(COMMANDS_PREFIX.length))
      .map((name) => name.replace(/\.[^/.]+$/, ''))
      .filter(Boolean);
  }, [workspaceFiles]);
  const recentFiles = useMemo(() => {
    if (!activeWorkspaceId) {
      return [];
    }
    return recentFilesByWorkspace[activeWorkspaceId] ?? [];
  }, [activeWorkspaceId, recentFilesByWorkspace]);
  const filePreview = useMemo(() => {
    if (!activeWorkspaceId) {
      return null;
    }
    return filePreviewByWorkspace[activeWorkspaceId] ?? null;
  }, [activeWorkspaceId, filePreviewByWorkspace]);
  const activeGitStatus = useMemo(() => {
    if (!activeWorkspaceId) {
      return [];
    }
    return gitStatusByWorkspace[activeWorkspaceId] ?? [];
  }, [activeWorkspaceId, gitStatusByWorkspace]);
  const activeGitStatusError = activeWorkspaceId
    ? gitStatusErrorByWorkspace[activeWorkspaceId] ?? null
    : null;
  const activeGitStatusLoading = activeWorkspaceId
    ? gitStatusLoadingByWorkspace[activeWorkspaceId] ?? false
    : false;
  const activeWorkspaceDiff = activeWorkspaceId
    ? workspaceDiffByWorkspace[activeWorkspaceId] ?? ''
    : '';
  const activeWorkspaceDiffError = activeWorkspaceId
    ? workspaceDiffErrorByWorkspace[activeWorkspaceId] ?? null
    : null;
  const activeWorkspaceDiffLoading = activeWorkspaceId
    ? diffLoadingByWorkspace[activeWorkspaceId] ?? false
    : false;
  const selectedDiffPath = activeWorkspaceId
    ? selectedDiffPathByWorkspace[activeWorkspaceId] ?? null
    : null;
  const workspaceFileTree = useMemo(
    () => buildFileTree(workspaceFiles),
    [workspaceFiles],
  );
  const activeRunStatus = activeWorkspaceId
    ? runStatusByWorkspace[activeWorkspaceId] ?? 'idle'
    : 'idle';
  const activeRunOutput = activeWorkspaceId
    ? runOutputByWorkspace[activeWorkspaceId] ?? []
    : [];
  const activeRunError = activeWorkspaceId
    ? runErrorByWorkspace[activeWorkspaceId] ?? null
    : null;
  const activeTerminalError = activeWorkspaceId
    ? terminalErrorByWorkspace[activeWorkspaceId] ?? null
    : null;
  const activeTerminalSessions = activeWorkspaceId
    ? terminalSessionsByWorkspace[activeWorkspaceId] ?? []
    : [];
  const activeTerminalId = activeWorkspaceId
    ? activeTerminalByWorkspace[activeWorkspaceId] ?? activeTerminalSessions[0]?.id ?? null
    : null;
  const activeWorkspace = useMemo(() => {
    if (!activeWorkspaceId) {
      return null;
    }
    return workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null;
  }, [activeWorkspaceId, workspaces]);
  const activeRepo = useMemo(() => {
    if (!activeWorkspace) {
      return null;
    }
    return repos.find((repo) => repo.id === activeWorkspace.repoId) ?? null;
  }, [activeWorkspace, repos]);
  const activeTargetBranch =
    activeWorkspace?.intendedTargetBranch ??
    activeRepo?.defaultBranch ??
    null;
  const activePullRequestStatus = activeWorkspaceId
    ? pullRequestStatusByWorkspace[activeWorkspaceId] ?? null
    : null;
  const activePullRequestError = activeWorkspaceId
    ? pullRequestStatusErrorByWorkspace[activeWorkspaceId] ?? null
    : null;
  const activePullRequestLoading = activeWorkspaceId
    ? pullRequestStatusLoadingByWorkspace[activeWorkspaceId] ?? false
    : false;
  const activePullRequestActionError = activeWorkspaceId
    ? pullRequestActionErrorByWorkspace[activeWorkspaceId] ?? null
    : null;
  const activePullRequestActionLoading = activeWorkspaceId
    ? pullRequestActionLoadingByWorkspace[activeWorkspaceId] ?? false
    : false;
  const activeRepoBranches = useMemo(
    () => (activeRepo ? repoBranchesByRepoId[activeRepo.id] ?? [] : []),
    [activeRepo, repoBranchesByRepoId],
  );
  const targetBranchOptions = useMemo(() => {
    const options = new Set<string>();
    for (const branch of activeRepoBranches) {
      if (branch.trim()) {
        options.add(branch);
      }
    }
    if (activeRepo?.defaultBranch) {
      options.add(activeRepo.defaultBranch);
    }
    if (activeWorkspace?.intendedTargetBranch) {
      options.add(activeWorkspace.intendedTargetBranch);
    }
    return Array.from(options).sort((a, b) => a.localeCompare(b));
  }, [activeRepo, activeRepoBranches, activeWorkspace]);
  const activePullRequestNumber =
    activePullRequestStatus?.number ?? activeWorkspace?.prNumber ?? null;
  const activePullRequestUrl =
    activePullRequestStatus?.url ?? activeWorkspace?.prUrl ?? null;
  const reviewDecisionLabel = useMemo(() => {
    const decision = activePullRequestStatus?.reviewDecision;
    if (!decision) {
      return null;
    }
    const normalized = decision.replace(/_/g, ' ').toLowerCase();
    if (normalized === 'changes requested') {
      return 'Changes requested';
    }
    if (normalized === 'approved') {
      return 'Approved';
    }
    if (normalized === 'review required') {
      return 'Review required';
    }
    return decision;
  }, [activePullRequestStatus]);
  const hasChangesRequested =
    reviewDecisionLabel?.toLowerCase() === 'changes requested';
  const checksSummaryText = activePullRequestStatus
    ? `${activePullRequestStatus.checks.failed} / ${activePullRequestStatus.checks.total} checks failed`
    : null;
  const hasFailingChecks = Boolean(
    activePullRequestStatus && activePullRequestStatus.checks.failed > 0,
  );
  const githubAvailable = githubAuthStatus?.available ?? false;
  const githubAuthenticated = githubAuthStatus?.authenticated ?? false;
  const githubReady = githubAvailable && githubAuthenticated;
  const visibleFileCount = Math.min(fileListVisibleCount, workspaceFiles.length);
  const fileListIsTruncated = workspaceFiles.length > visibleFileCount;
  const showLeftSidebar = leftSidebarVisible && !zenMode;
  const showRightSidebar = rightSidebarVisible && !zenMode;
  const isMac = useMemo(
    () =>
      typeof navigator !== 'undefined' &&
      /Mac|iPhone|iPod|iPad/i.test(navigator.platform),
    [],
  );
  const closedSessions = useMemo(() => {
    if (!activeWorkspaceId) {
      return [];
    }
    const closedIds = closedSessionIdsByWorkspace[activeWorkspaceId] ?? [];
    const sessions = sessionsByWorkspace[activeWorkspaceId] ?? [];
    const byId = new Map(sessions.map((session) => [session.id, session]));
    return closedIds
      .map((id) => byId.get(id))
      .filter((session): session is SessionRecord => Boolean(session));
  }, [activeWorkspaceId, closedSessionIdsByWorkspace, sessionsByWorkspace]);
  const recentSessions = useMemo(() => {
    if (!activeWorkspaceId) {
      return [];
    }
    const sessions = sessionsByWorkspace[activeWorkspaceId] ?? [];
    return sessions.slice(-6).reverse();
  }, [activeWorkspaceId, sessionsByWorkspace]);
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

  const loadSessions = useCallback(async () => {
    setSessionListError(null);
    try {
      const data = await invoke<SessionRecord[]>('listSessions');
      const grouped: Record<string, SessionRecord[]> = {};
      for (const session of data) {
        const list = grouped[session.workspaceId] ?? [];
        list.push(session);
        grouped[session.workspaceId] = list;
      }
      let nextOpenByWorkspace: Record<string, string[]> = {};
      setOpenSessionIdsByWorkspace((prev) => {
        const next: Record<string, string[]> = {};
        for (const [workspaceId, list] of Object.entries(grouped)) {
          const available = list.map((session) => session.id);
          const hasExisting = Object.prototype.hasOwnProperty.call(prev, workspaceId);
          const existingOpen = prev[workspaceId] ?? [];
          const filteredOpen = existingOpen.filter((id) =>
            available.includes(id),
          );
          if (filteredOpen.length > 0) {
            next[workspaceId] = filteredOpen;
            continue;
          }
          if (hasExisting) {
            next[workspaceId] = [];
            continue;
          }
          next[workspaceId] =
            available.length > 0 ? [available[available.length - 1]] : [];
        }
        nextOpenByWorkspace = next;
        return next;
      });
      setClosedSessionIdsByWorkspace((prev) => {
        const next: Record<string, string[]> = {};
        for (const [workspaceId, list] of Object.entries(grouped)) {
          const available = list.map((session) => session.id);
          const existingClosed = prev[workspaceId] ?? [];
          const openIds = nextOpenByWorkspace[workspaceId] ?? [];
          next[workspaceId] = existingClosed.filter(
            (id) => available.includes(id) && !openIds.includes(id),
          );
        }
        return next;
      });
      setSessionsByWorkspace(grouped);
      setSessionStatuses(() => {
        const next: Record<string, SessionRecord['status']> = {};
        for (const session of data) {
          next[session.id] = session.status;
        }
        return next;
      });
      setPermissionModeBySession((prev) => {
        const next: Record<string, string> = {};
        for (const session of data) {
          next[session.id] = prev[session.id] ?? 'default';
        }
        return next;
      });
      setActiveSessionByWorkspace((prev) => {
        const next = { ...prev };
        for (const workspaceId of Object.keys(prev)) {
          if (!grouped[workspaceId] || grouped[workspaceId].length === 0) {
            next[workspaceId] = null;
          }
        }
        for (const workspaceId of Object.keys(grouped)) {
          const openIds = nextOpenByWorkspace[workspaceId] ?? [];
          const activeId = next[workspaceId];
          if (openIds.length === 0) {
            next[workspaceId] = null;
            continue;
          }
          if (activeId && openIds.includes(activeId)) {
            continue;
          }
          next[workspaceId] = openIds[openIds.length - 1];
        }
        return next;
      });
    } catch (err) {
      setSessionListError(String(err));
      setSessionsByWorkspace({});
      throw err;
    }
  }, []);

  const loadGithubAuthStatus = useCallback(async () => {
    setGithubAuthLoading(true);
    try {
      const status = await invoke<GithubAuthStatus>('getGithubAuthStatus');
      setGithubAuthStatus(status);
    } catch (err) {
      setGithubAuthStatus({
        available: false,
        authenticated: false,
        message: String(err),
      });
    } finally {
      setGithubAuthLoading(false);
    }
  }, []);

  const loadRepoBranches = useCallback(
    async (repoId: string, force = false) => {
      if (!force && repoBranchesByRepoId[repoId]) {
        return;
      }
      try {
        const branches = await invoke<string[]>('listRepoBranches', { repoId });
        setRepoBranchesByRepoId((prev) => ({ ...prev, [repoId]: branches }));
      } catch {
        setRepoBranchesByRepoId((prev) => ({
          ...prev,
          [repoId]: prev[repoId] ?? [],
        }));
      }
    },
    [repoBranchesByRepoId],
  );

  const loadPullRequestStatus = useCallback(
    async (workspaceId: string, force = false) => {
      if (!force && pullRequestStatusLoadingByWorkspace[workspaceId]) {
        return;
      }
      if (
        githubAuthStatus &&
        (!githubAuthStatus.available || !githubAuthStatus.authenticated)
      ) {
        setPullRequestStatusErrorByWorkspace((prev) => ({
          ...prev,
          [workspaceId]: null,
        }));
        setPullRequestStatusByWorkspace((prev) => ({
          ...prev,
          [workspaceId]: null,
        }));
        setPullRequestStatusLoadingByWorkspace((prev) => ({
          ...prev,
          [workspaceId]: false,
        }));
        return;
      }
      setPullRequestStatusErrorByWorkspace((prev) => ({
        ...prev,
        [workspaceId]: null,
      }));
      setPullRequestStatusLoadingByWorkspace((prev) => ({
        ...prev,
        [workspaceId]: true,
      }));
      try {
        const status = await invoke<PullRequestStatus | null>(
          'getPullRequestStatus',
          { workspaceId },
        );
        setPullRequestStatusByWorkspace((prev) => ({
          ...prev,
          [workspaceId]: status,
        }));
      } catch (err) {
        setPullRequestStatusErrorByWorkspace((prev) => ({
          ...prev,
          [workspaceId]: String(err),
        }));
        setPullRequestStatusByWorkspace((prev) => ({
          ...prev,
          [workspaceId]: null,
        }));
      } finally {
        setPullRequestStatusLoadingByWorkspace((prev) => ({
          ...prev,
          [workspaceId]: false,
        }));
      }
    },
    [githubAuthStatus, pullRequestStatusLoadingByWorkspace],
  );

  const loadGitStatus = useCallback(async (workspaceId: string) => {
    setGitStatusErrorByWorkspace((prev) => ({ ...prev, [workspaceId]: null }));
    setGitStatusLoadingByWorkspace((prev) => ({ ...prev, [workspaceId]: true }));
    try {
      const data = await invoke<GitStatusEntry[]>('getWorkspaceGitStatus', {
        workspaceId,
      });
      setGitStatusByWorkspace((prev) => ({ ...prev, [workspaceId]: data }));
    } catch (err) {
      setGitStatusErrorByWorkspace((prev) => ({
        ...prev,
        [workspaceId]: String(err),
      }));
      setGitStatusByWorkspace((prev) => ({ ...prev, [workspaceId]: [] }));
    } finally {
      setGitStatusLoadingByWorkspace((prev) => ({
        ...prev,
        [workspaceId]: false,
      }));
    }
  }, []);

  const loadWorkspaceDiff = useCallback(
    async (workspaceId: string, path?: string | null) => {
      setWorkspaceDiffErrorByWorkspace((prev) => ({
        ...prev,
        [workspaceId]: null,
      }));
      setDiffLoadingByWorkspace((prev) => ({ ...prev, [workspaceId]: true }));
      try {
        const response = await invoke<WorkspaceDiffResponse>('getWorkspaceDiff', {
          workspaceId,
          path: path ?? null,
          stat: false,
        });
        setWorkspaceDiffByWorkspace((prev) => ({
          ...prev,
          [workspaceId]: response.diff,
        }));
      } catch (err) {
        setWorkspaceDiffErrorByWorkspace((prev) => ({
          ...prev,
          [workspaceId]: String(err),
        }));
        setWorkspaceDiffByWorkspace((prev) => ({ ...prev, [workspaceId]: '' }));
      } finally {
        setDiffLoadingByWorkspace((prev) => ({
          ...prev,
          [workspaceId]: false,
        }));
      }
    },
    [],
  );

  const loadReviewSettings = useCallback(async () => {
    try {
      const entries = await invoke<SettingsEntry[]>('listSettings');
      const byKey = new Map(entries.map((entry) => [entry.key, entry.value]));  
      setReviewModel(byKey.get('review_model') ?? null);
      setReviewThinkingLevel(byKey.get('review_thinking_level') ?? null);       
    } catch (err) {
      console.warn('Failed to load review settings:', err);
    }
  }, []);

  const loadSessionMessages = useCallback(async (sessionId: string) => {
    try {
      const data = await invoke<SessionMessageRecord[]>('listSessionMessages', {
        sessionId,
      });
      const normalized = data.map((message) => normalizeSessionMessage(message));
      setMessagesBySession((prev) => ({ ...prev, [sessionId]: normalized }));
    } catch (err) {
      setSessionErrors((prev) => ({ ...prev, [sessionId]: String(err) }));
    }
  }, []);

  const loadSessionAttachments = useCallback(async (sessionId: string) => {
    try {
      const data = await invoke<AttachmentRecord[]>('listSessionAttachments', {
        sessionId,
      });
      const drafts = data.filter((item) => item.isDraft);
      const attached = data.filter((item) => !item.isDraft);
      setAttachmentsBySession((prev) => ({ ...prev, [sessionId]: attached }));
      setDraftAttachmentsBySession((prev) => ({ ...prev, [sessionId]: drafts }));
    } catch (err) {
      setSessionErrors((prev) => ({ ...prev, [sessionId]: String(err) }));
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

  useEffect(() => {
    let active = true;
    loadSessions().catch((err) => {
      if (active) {
        setSessionListError(String(err));
      }
    });
    return () => {
      active = false;
    };
  }, [loadSessions]);

  useEffect(() => {
    void loadReviewSettings();
  }, [loadReviewSettings]);

  useEffect(() => {
    void loadGithubAuthStatus();
  }, [loadGithubAuthStatus]);

  useEffect(() => {
    if (!activeSessionId) {
      return;
    }
    if (messagesBySession[activeSessionId]) {
      return;
    }
    loadSessionMessages(activeSessionId);
  }, [activeSessionId, loadSessionMessages, messagesBySession]);

  useEffect(() => {
    if (!activeSessionId) {
      return;
    }
    const hasAttachments =
      Object.prototype.hasOwnProperty.call(
        attachmentsBySession,
        activeSessionId,
      ) ||
      Object.prototype.hasOwnProperty.call(
        draftAttachmentsBySession,
        activeSessionId,
      );
    if (hasAttachments) {
      return;
    }
    loadSessionAttachments(activeSessionId);
  }, [
    activeSessionId,
    attachmentsBySession,
    draftAttachmentsBySession,
    loadSessionAttachments,
  ]);

  useEffect(() => {
    setSendError(null);
  }, [activeSessionId]);

  useEffect(() => {
    setNewChatModelByAgent((prev) => ({
      claude: prev.claude ?? getDefaultModel('claude'),
      codex: prev.codex ?? getDefaultModel('codex'),
    }));
  }, []);

  useEffect(() => {
    if (!activeAskRequest) {
      return;
    }
    setAskAnswers(
      activeAskRequest.questions.map((question) => question.options[0] ?? ''),
    );
  }, [activeAskRequest]);

  useEffect(() => {
    window.localStorage.setItem(
      STORAGE_KEYS.leftVisible,
      String(leftSidebarVisible),
    );
    window.localStorage.setItem(
      STORAGE_KEYS.rightVisible,
      String(rightSidebarVisible),
    );
    window.localStorage.setItem(STORAGE_KEYS.zenMode, String(zenMode));
    window.localStorage.setItem(
      STORAGE_KEYS.leftWidth,
      String(leftSidebarWidth),
    );
    window.localStorage.setItem(
      STORAGE_KEYS.rightWidth,
      String(rightSidebarWidth),
    );
  }, [
    leftSidebarVisible,
    rightSidebarVisible,
    zenMode,
    leftSidebarWidth,
    rightSidebarWidth,
  ]);

  useEffect(() => {
    writeJson(STORAGE_KEYS.openSessions, openSessionIdsByWorkspace);
  }, [openSessionIdsByWorkspace]);

  useEffect(() => {
    writeJson(STORAGE_KEYS.activeSessions, activeSessionByWorkspace);
  }, [activeSessionByWorkspace]);

  useEffect(() => {
    const runOutputUnlisten = listen<RunOutputEvent>('run-output', (event) => {
      const { workspaceId, stream, line } = event.payload;
      const normalizedStream = stream === 'stderr' ? 'stderr' : 'stdout';
      const entry = createRunOutputEntry(normalizedStream, line);
      setRunOutputByWorkspace((prev) => {
        const existing = prev[workspaceId] ?? [];
        const next = [...existing, entry];
        if (next.length > RUN_OUTPUT_LIMIT) {
          next.splice(0, next.length - RUN_OUTPUT_LIMIT);
        }
        return { ...prev, [workspaceId]: next };
      });
    });
    const runExitUnlisten = listen<RunExitEvent>('run-exit', (event) => {
      const { workspaceId, code } = event.payload;
      setRunStatusByWorkspace((prev) => ({ ...prev, [workspaceId]: 'idle' }));
      setRunOutputByWorkspace((prev) => {
        const existing = prev[workspaceId] ?? [];
        const line =
          code === 0
            ? 'Run completed successfully.'
            : `Run exited with code ${code ?? 'unknown'}.`;
        const entry = createRunOutputEntry('stdout', line);
        const next = [...existing, entry];
        if (next.length > RUN_OUTPUT_LIMIT) {
          next.splice(0, next.length - RUN_OUTPUT_LIMIT);
        }
        return { ...prev, [workspaceId]: next };
      });
    });
    const terminalExitUnlisten = listen<TerminalExitEvent>(
      'terminal-exit',
      (event) => {
        const { terminalId } = event.payload;
        let affectedWorkspace: string | null = null;
        let remainingSessions: TerminalSession[] = [];
        setTerminalSessionsByWorkspace((prev) => {
          const next = { ...prev };
          for (const [workspaceId, sessions] of Object.entries(prev)) {
            if (!sessions.some((session) => session.id === terminalId)) {
              continue;
            }
            next[workspaceId] = sessions.filter(
              (session) => session.id !== terminalId,
            );
            affectedWorkspace = workspaceId;
          }
          remainingSessions = affectedWorkspace ? next[affectedWorkspace] ?? [] : [];
          return next;
        });
        if (affectedWorkspace) {
          const workspaceId = affectedWorkspace;
          const remaining = remainingSessions;
          setActiveTerminalByWorkspace((activePrev) => {
            if (activePrev[workspaceId] !== terminalId) {
              return activePrev;
            }
            return {
              ...activePrev,
              [workspaceId]: remaining[0]?.id ?? null,
            };
          });
        }
      },
    );
    const sessionMessageUnlisten = listen<SessionMessageEvent>(
      'session-message',
      (event) => {
        const { sessionId, message } = event.payload;
        setMessagesBySession((prev) => {
          const existing = prev[sessionId] ?? [];
          const index = existing.findIndex((item) => item.id === message.id);
          const metadata =
            message.metadata && typeof message.metadata === 'object'
              ? (message.metadata as Record<string, unknown>)
              : null;
          const nextItem: SessionMessageItem = {
            id: message.id,
            sessionId,
            role: message.role,
            content: message.content,
            metadata,
            checkpointId: null,
            streaming: message.streaming,
          };
          if (index >= 0) {
            const updated = [...existing];
            const current = updated[index];
            updated[index] = {
              ...current,
              ...nextItem,
              turnId: current.turnId ?? nextItem.turnId,
              sentAt: current.sentAt ?? nextItem.sentAt,
              cancelledAt: current.cancelledAt ?? nextItem.cancelledAt,
              checkpointId: current.checkpointId ?? nextItem.checkpointId,
            };
            return { ...prev, [sessionId]: updated };
          }
          return { ...prev, [sessionId]: [...existing, nextItem] };
        });
      },
    );
    const sessionErrorUnlisten = listen<SessionErrorEvent>(
      'session-error',
      (event) => {
        const { sessionId, error } = event.payload;
        setSessionErrors((prev) => ({ ...prev, [sessionId]: error }));
        setSessionStatuses((prev) => ({ ...prev, [sessionId]: 'error' }));
      },
    );
    const sessionStatusUnlisten = listen<SessionStatusEvent>(
      'session-status',
      (event) => {
        const { sessionId, status } = event.payload;
        setSessionStatuses((prev) => ({ ...prev, [sessionId]: status }));
      },
    );
    const sessionPlanModeUnlisten = listen<SessionPlanModeEvent>(
      'session-plan-mode',
      (event) => {
        const { sessionId } = event.payload;
        setPlanModeBySession((prev) => ({ ...prev, [sessionId]: true }));
      },
    );
    const sessionRequestUnlisten = listen<AskUserQuestionEvent | ExitPlanModeEvent>(
      'session-request',
      (event) => {
        const payload = event.payload as AskUserQuestionEvent | ExitPlanModeEvent;
        if ('questions' in payload) {
          setPendingAskQueue((prev) => [...prev, payload]);
        } else {
          setPendingExitQueue((prev) => [...prev, payload]);
        }
      },
    );
    return () => {
      void runOutputUnlisten.then((unlisten) => unlisten());
      void runExitUnlisten.then((unlisten) => unlisten());
      void terminalExitUnlisten.then((unlisten) => unlisten());
      void sessionMessageUnlisten.then((unlisten) => unlisten());
      void sessionErrorUnlisten.then((unlisten) => unlisten());
      void sessionStatusUnlisten.then((unlisten) => unlisten());
      void sessionPlanModeUnlisten.then((unlisten) => unlisten());
      void sessionRequestUnlisten.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (leftResizeState.current) {
        const delta = event.clientX - leftResizeState.current.startX;
        const nextWidth = clamp(leftResizeState.current.startWidth + delta, 220, 420);
        setLeftSidebarWidth(nextWidth);
      }
      if (rightResizeState.current) {
        const delta = event.clientX - rightResizeState.current.startX;
        const nextWidth = clamp(rightResizeState.current.startWidth - delta, 260, 520);
        setRightSidebarWidth(nextWidth);
      }
    };
    const handleUp = () => {
      if (leftResizeState.current || rightResizeState.current) {
        leftResizeState.current = null;
        rightResizeState.current = null;
        document.body.style.userSelect = '';
      }
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, []);

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
      setActiveTabByWorkspace((prev) => ({ ...prev, [workspace.id]: 'changes' }));
      closeCreateWorkspace();
    } catch (err) {
      setCreateWorkspaceState('error');
      setCreateWorkspaceError(String(err));
    }
  };

  const handleArchiveWorkspace = async (workspace: WorkspaceInfo, allowScript: boolean) => {
    setWorkspaceError(null);
    try {
      await invoke('archiveWorkspace', { workspaceId: workspace.id, allowScript });
      await loadWorkspaces();
      if (selectedWorkspaceId === workspace.id) {
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

  const handleUnreadWorkspace = useCallback(
    async (workspaceId: string, unread: boolean) => {
      setWorkspaceError(null);
      try {
        await invoke('markWorkspaceUnread', { workspaceId, unread });
        await loadWorkspaces();
      } catch (err) {
        setWorkspaceError(String(err));
      }
    },
    [loadWorkspaces],
  );

  const handleSelectWorkspace = useCallback(
    async (workspace: WorkspaceInfo) => {
      setSelectedWorkspaceId(workspace.id);
      setActiveView('workspace');
      setActiveTabByWorkspace((prev) => ({
        ...prev,
        [workspace.id]: prev[workspace.id] ?? 'changes',
      }));
      if (workspace.unread) {
        await handleUnreadWorkspace(workspace.id, false);
      }
    },
    [handleUnreadWorkspace],
  );

  const toggleLeftSidebar = useCallback(() => {
    setZenMode(false);
    setLeftSidebarVisible((prev) => !prev);
  }, []);

  const toggleRightSidebar = useCallback(() => {
    setZenMode(false);
    setRightSidebarVisible((prev) => !prev);
  }, []);

  const toggleZenMode = useCallback(() => {
    setZenMode((prev) => !prev);
  }, []);

  const startLeftResize = useCallback(
    (event: React.MouseEvent) => {
      leftResizeState.current = {
        startX: event.clientX,
        startWidth: leftSidebarWidth,
      };
      document.body.style.userSelect = 'none';
    },
    [leftSidebarWidth],
  );

  const startRightResize = useCallback(
    (event: React.MouseEvent) => {
      rightResizeState.current = {
        startX: event.clientX,
        startWidth: rightSidebarWidth,
      };
      document.body.style.userSelect = 'none';
    },
    [rightSidebarWidth],
  );

  const createSessionForWorkspace = useCallback(
    async (
      workspaceId: string,
      agentType = newChatAgentType,
      modelOverride?: string | null,
    ) => {
      setSessionListError(null);
      try {
        const resolvedModel =
          modelOverride ??
          newChatModelByAgent[agentType] ??
          getDefaultModel(agentType);
        const session = await invoke<SessionRecord>('createSession', {
          workspaceId,
          agentType,
          model: resolvedModel,
        });
        setSessionsByWorkspace((prev) => {
          const list = prev[workspaceId] ?? [];
          return { ...prev, [workspaceId]: [...list, session] };
        });
        setMessagesBySession((prev) => ({ ...prev, [session.id]: [] }));
        setSessionStatuses((prev) => ({ ...prev, [session.id]: session.status }));
        setPermissionModeBySession((prev) => ({
          ...prev,
          [session.id]: prev[session.id] ?? 'default',
        }));
        setOpenSessionIdsByWorkspace((prev) => {
          const existing = prev[workspaceId] ?? [];
          if (existing.includes(session.id)) {
            return prev;
          }
          return { ...prev, [workspaceId]: [...existing, session.id] };
        });
        setClosedSessionIdsByWorkspace((prev) => {
          const existing = prev[workspaceId] ?? [];
          if (!existing.includes(session.id)) {
            return prev;
          }
          return {
            ...prev,
            [workspaceId]: existing.filter((id) => id !== session.id),
          };
        });
        setActiveSessionByWorkspace((prev) => ({
          ...prev,
          [workspaceId]: session.id,
        }));
        setActiveTabByWorkspace((prev) => ({
          ...prev,
          [workspaceId]: 'session',
        }));
        return session;
      } catch (err) {
        setSessionListError(String(err));
        throw err;
      }
    },
    [newChatAgentType, newChatModelByAgent],
  );

  const handleNewChat = useCallback(() => {
    if (!activeWorkspaceId) {
      return;
    }
    setNewChatContextIds([]);
    setNewChatOpen(true);
    setActiveView('workspace');
  }, [activeWorkspaceId, setActiveView]);

  const handleStartNewChat = useCallback(async () => {
    if (!activeWorkspaceId) {
      return;
    }
    try {
      await createSessionForWorkspace(
        activeWorkspaceId,
        newChatAgentType,
        newChatModelByAgent[newChatAgentType] ??
          getDefaultModel(newChatAgentType),
      );
      setNewChatOpen(false);
      setNewChatContextIds([]);
    } catch {
      return;
    }
  }, [
    activeWorkspaceId,
    createSessionForWorkspace,
    newChatAgentType,
    newChatModelByAgent,
  ]);

  const toggleNewChatContext = useCallback((sessionId: string) => {
    setNewChatContextIds((prev) =>
      prev.includes(sessionId)
        ? prev.filter((id) => id !== sessionId)
        : [...prev, sessionId],
    );
  }, []);

  const handleSelectSession = useCallback(
    (workspaceId: string, sessionId: string) => {
      setSelectedWorkspaceId(workspaceId);
      setActiveView('workspace');
      setOpenSessionIdsByWorkspace((prev) => {
        const existing = prev[workspaceId] ?? [];
        if (existing.includes(sessionId)) {
          return prev;
        }
        return { ...prev, [workspaceId]: [...existing, sessionId] };
      });
      setClosedSessionIdsByWorkspace((prev) => {
        const existing = prev[workspaceId] ?? [];
        if (!existing.includes(sessionId)) {
          return prev;
        }
        return {
          ...prev,
          [workspaceId]: existing.filter((id) => id !== sessionId),
        };
      });
      setActiveSessionByWorkspace((prev) => ({
        ...prev,
        [workspaceId]: sessionId,
      }));
      setActiveTabByWorkspace((prev) => ({
        ...prev,
        [workspaceId]: 'session',
      }));
    },
    [],
  );

  const handleCloseSession = useCallback(
    (workspaceId: string, sessionId: string) => {
      const isClosingActive =
        activeSessionByWorkspace[workspaceId] === sessionId;
      let nextOpenIds: string[] = [];
      setOpenSessionIdsByWorkspace((prev) => {
        const existing = prev[workspaceId] ?? [];
        if (!existing.includes(sessionId)) {
          nextOpenIds = existing;
          return prev;
        }
        nextOpenIds = existing.filter((id) => id !== sessionId);
        return {
          ...prev,
          [workspaceId]: nextOpenIds,
        };
      });
      setClosedSessionIdsByWorkspace((prev) => {
        const existing = prev[workspaceId] ?? [];
        const next = [
          sessionId,
          ...existing.filter((id) => id !== sessionId),
        ].slice(0, 8);
        return { ...prev, [workspaceId]: next };
      });
      if (isClosingActive) {
        setActiveSessionByWorkspace((prev) => {
          return {
            ...prev,
            [workspaceId]:
              nextOpenIds.length > 0 ? nextOpenIds[nextOpenIds.length - 1] : null,
          };
        });
        setActiveTabByWorkspace((prev) => ({
          ...prev,
          [workspaceId]: nextOpenIds.length > 0 ? 'session' : 'changes',
        }));
      }
    },
    [activeSessionByWorkspace],
  );

  const handleSendMessage = useCallback(async () => {
    if (!activeWorkspaceId) {
      return;
    }
    setActiveView('workspace');
    const prompt = composerValue.trim();
    if (!prompt) {
      return;
    }
    if (activeSessionStatus === 'running') {
      return;
    }
    setSendError(null);
    setActiveTabByWorkspace((prev) => ({
      ...prev,
      [activeWorkspaceId]: 'session',
    }));
    let session = activeSession;
    if (!session) {
      try {
        session = await createSessionForWorkspace(activeWorkspaceId);
      } catch {
        return;
      }
    }
    const permissionMode =
      session.agentType === 'claude'
        ? permissionModeBySession[session.id] ?? 'default'
        : undefined;
    const draftAttachments = draftAttachmentsBySession[session.id] ?? [];
    const attachmentIds = draftAttachments.map((item) => item.id);
    try {
      setSessionErrors((prev) => ({ ...prev, [session.id]: null }));
      const userMessage = await invoke<SessionMessageRecord>('sendSessionMessage', {
        sessionId: session.id,
        prompt,
        permissionMode,
        attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
      });
      const normalized = normalizeSessionMessage(userMessage);
      setMessagesBySession((prev) => {
        const list = prev[session.id] ?? [];
        return { ...prev, [session.id]: [...list, normalized] };
      });
      setComposerValue('');
      setComposerSuggestions([]);
      setComposerSuggestionIndex(0);
      setComposerSuggestionRange(null);
      setDraftAttachmentsBySession((prev) => ({
        ...prev,
        [session.id]: [],
      }));
      await loadSessionAttachments(session.id);
      if (pendingIssueId) {
        setLinkedIssueBySession((prev) => ({
          ...prev,
          [session.id]: pendingIssueId,
        }));
        setPendingIssueId(null);
      }
      setSessionStatuses((prev) => ({ ...prev, [session.id]: 'running' }));
    } catch (err) {
      setSendError(String(err));
      setSessionErrors((prev) => ({ ...prev, [session.id]: String(err) }));
    }
  }, [
    activeSession,
    activeSessionStatus,
    activeWorkspaceId,
    composerValue,
    createSessionForWorkspace,
    draftAttachmentsBySession,
    loadSessionAttachments,
    pendingIssueId,
    permissionModeBySession,
  ]);

  const handleReviewChanges = useCallback(async () => {
    if (!activeWorkspaceId) {
      return;
    }
    setSendError(null);
    setActiveView('workspace');
    const modelId = reviewModel ?? getDefaultModel('codex');
    const agentType =
      (modelId ? MODEL_LOOKUP.agentById.get(modelId) : null) ?? 'codex';
    let session: SessionRecord;
    try {
      session = await createSessionForWorkspace(activeWorkspaceId, agentType, modelId);
    } catch {
      return;
    }
    const permissionMode =
      agentType === 'claude' ? permissionModeBySession[session.id] ?? 'default' : undefined;
    let diffText = '';
    let diffTruncated = false;
    try {
      const response = await invoke<WorkspaceDiffResponse>('getWorkspaceDiff', {
        workspaceId: activeWorkspaceId,
        path: null,
        stat: false,
      });
      const trimmed = response.diff.trim();
      const truncated = truncateReviewDiff(trimmed);
      diffText = truncated.text;
      diffTruncated = truncated.truncated;
    } catch (err) {
      setSendError(String(err));
      return;
    }
    const thinking = reviewThinkingLevel ?? 'medium';
    const promptLines = [
      'Review the following git diff and leave concise, actionable feedback.',
      `Thinking level: ${thinking}.`,
      'Output format: Summary, Issues (if any), Suggestions.',
      diffTruncated ? 'Diff truncated to fit the review prompt.' : null,
      diffText ? '```diff\n' + diffText + '\n```' : 'No changes detected in the workspace.',
    ].filter((line): line is string => Boolean(line));
    const prompt = promptLines.join('\n');
    try {
      setSessionErrors((prev) => ({ ...prev, [session.id]: null }));
      const userMessage = await invoke<SessionMessageRecord>('sendSessionMessage', {
        sessionId: session.id,
        prompt,
        permissionMode,
      });
      const normalized = normalizeSessionMessage(userMessage);
      setMessagesBySession((prev) => {
        const list = prev[session.id] ?? [];
        return { ...prev, [session.id]: [...list, normalized] };
      });
      setSessionStatuses((prev) => ({ ...prev, [session.id]: 'running' }));
      setActiveTabByWorkspace((prev) => ({
        ...prev,
        [activeWorkspaceId]: 'session',
      }));
    } catch (err) {
      setSendError(String(err));
      setSessionErrors((prev) => ({ ...prev, [session.id]: String(err) }));
    }
  }, [
    activeWorkspaceId,
    createSessionForWorkspace,
    permissionModeBySession,
    reviewModel,
    reviewThinkingLevel,
  ]);

  const sendPromptWithGeneratedAttachment = useCallback(
    async ({
      workspaceId,
      prompt,
      fileName,
      content,
      mimeType,
    }: {
      workspaceId: string;
      prompt: string;
      fileName: string;
      content: string;
      mimeType?: string;
    }) => {
      setSendError(null);
      let session = activeSession;
      if (!session) {
        session = await createSessionForWorkspace(
          workspaceId,
          newChatAgentType,
          newChatModelByAgent[newChatAgentType] ??
            getDefaultModel(newChatAgentType),
        );
      }
      const bytes = Array.from(new TextEncoder().encode(content));
      const attachment = await invoke<AttachmentRecord>('createAttachment', {
        sessionId: session.id,
        fileName,
        mimeType,
        bytes,
      });
      const permissionMode =
        session.agentType === 'claude'
          ? permissionModeBySession[session.id] ?? 'default'
          : undefined;
      setSessionErrors((prev) => ({ ...prev, [session.id]: null }));
      const userMessage = await invoke<SessionMessageRecord>('sendSessionMessage', {
        sessionId: session.id,
        prompt,
        permissionMode,
        attachmentIds: [attachment.id],
      });
      const normalized = normalizeSessionMessage(userMessage);
      setMessagesBySession((prev) => {
        const list = prev[session.id] ?? [];
        return { ...prev, [session.id]: [...list, normalized] };
      });
      setSessionStatuses((prev) => ({ ...prev, [session.id]: 'running' }));
      setActiveTabByWorkspace((prev) => ({
        ...prev,
        [workspaceId]: 'session',
      }));
      await loadSessionAttachments(session.id);
      return session;
    },
    [
      activeSession,
      createSessionForWorkspace,
      loadSessionAttachments,
      newChatAgentType,
      newChatModelByAgent,
      permissionModeBySession,
    ],
  );

  const handleCreatePullRequest = useCallback(async () => {
    if (!activeWorkspaceId) {
      return;
    }
    if (!githubAuthStatus?.available || !githubAuthStatus.authenticated) {
      setPullRequestActionErrorByWorkspace((prev) => ({
        ...prev,
        [activeWorkspaceId]:
          githubAuthStatus?.message ??
          'GitHub CLI is not authenticated. Run `gh auth login`.',
      }));
      return;
    }
    setPullRequestActionErrorByWorkspace((prev) => ({
      ...prev,
      [activeWorkspaceId]: null,
    }));
    setPullRequestActionLoadingByWorkspace((prev) => ({
      ...prev,
      [activeWorkspaceId]: true,
    }));
    try {
      await invoke<PullRequestInfo>('createPullRequest', {
        workspaceId: activeWorkspaceId,
      });
      await loadWorkspaces();
      await loadPullRequestStatus(activeWorkspaceId, true);
    } catch (err) {
      setPullRequestActionErrorByWorkspace((prev) => ({
        ...prev,
        [activeWorkspaceId]: String(err),
      }));
    } finally {
      setPullRequestActionLoadingByWorkspace((prev) => ({
        ...prev,
        [activeWorkspaceId]: false,
      }));
    }
  }, [
    activeWorkspaceId,
    githubAuthStatus,
    loadPullRequestStatus,
    loadWorkspaces,
  ]);

  const handleSetTargetBranch = useCallback(
    async (branch: string) => {
      if (!activeWorkspaceId) {
        return;
      }
      const trimmed = branch.trim();
      if (!trimmed || trimmed === activeTargetBranch) {
        return;
      }
      setPullRequestActionErrorByWorkspace((prev) => ({
        ...prev,
        [activeWorkspaceId]: null,
      }));
      setPullRequestActionLoadingByWorkspace((prev) => ({
        ...prev,
        [activeWorkspaceId]: true,
      }));
      try {
        await invoke('setWorkspaceTargetBranch', {
          workspaceId: activeWorkspaceId,
          targetBranch: trimmed,
        });
        await loadWorkspaces();
      } catch (err) {
        setPullRequestActionErrorByWorkspace((prev) => ({
          ...prev,
          [activeWorkspaceId]: String(err),
        }));
      } finally {
        setPullRequestActionLoadingByWorkspace((prev) => ({
          ...prev,
          [activeWorkspaceId]: false,
        }));
      }
    },
    [activeTargetBranch, activeWorkspaceId, loadWorkspaces],
  );

  const handleFixErrors = useCallback(async () => {
    if (!activeWorkspaceId) {
      return;
    }
    setPullRequestActionErrorByWorkspace((prev) => ({
      ...prev,
      [activeWorkspaceId]: null,
    }));
    setPullRequestActionLoadingByWorkspace((prev) => ({
      ...prev,
      [activeWorkspaceId]: true,
    }));
    try {
      const logs = await invoke<string>('getPullRequestFailureLogs', {
        workspaceId: activeWorkspaceId,
      });
      const trimmed = logs.trim();
      if (!trimmed) {
        setPullRequestActionErrorByWorkspace((prev) => ({
          ...prev,
          [activeWorkspaceId]: 'No failing check logs were returned.',
        }));
        return;
      }
      const prNumber =
        activePullRequestStatus?.number ?? activeWorkspace?.prNumber ?? null;
      const promptLines = [
        prNumber ? `Fix the CI failures for PR #${prNumber}.` : 'Fix the CI failures for this PR.',
        'Review the attached logs and apply the necessary code changes.',
      ];
      await sendPromptWithGeneratedAttachment({
        workspaceId: activeWorkspaceId,
        prompt: promptLines.join('\n'),
        fileName: prNumber ? `pr-${prNumber}-checks.log` : 'pr-checks.log',
        content: logs,
        mimeType: 'text/plain',
      });
    } catch (err) {
      setPullRequestActionErrorByWorkspace((prev) => ({
        ...prev,
        [activeWorkspaceId]: String(err),
      }));
    } finally {
      setPullRequestActionLoadingByWorkspace((prev) => ({
        ...prev,
        [activeWorkspaceId]: false,
      }));
    }
  }, [
    activePullRequestStatus,
    activeWorkspace,
    activeWorkspaceId,
    sendPromptWithGeneratedAttachment,
  ]);

  const handleFetchComments = useCallback(async () => {
    if (!activeWorkspaceId) {
      return;
    }
    setPullRequestActionErrorByWorkspace((prev) => ({
      ...prev,
      [activeWorkspaceId]: null,
    }));
    setPullRequestActionLoadingByWorkspace((prev) => ({
      ...prev,
      [activeWorkspaceId]: true,
    }));
    try {
      const result = await invoke<PullRequestCommentsResult>('fetchPullRequestComments', {
        workspaceId: activeWorkspaceId,
      });
      if (!result.content.trim()) {
        setPullRequestActionErrorByWorkspace((prev) => ({
          ...prev,
          [activeWorkspaceId]: 'No review comments found for this PR.',
        }));
        return;
      }
      const prNumber =
        activePullRequestStatus?.number ?? activeWorkspace?.prNumber ?? null;
      const promptLines = [
        prNumber
          ? `Review comments fetched for PR #${prNumber}.`
          : 'Review comments fetched for this PR.',
        'Please address the requested changes using the attached feedback.',
      ];
      await sendPromptWithGeneratedAttachment({
        workspaceId: activeWorkspaceId,
        prompt: promptLines.join('\n'),
        fileName: prNumber ? `pr-${prNumber}-comments.md` : 'pr-comments.md',
        content: result.content,
        mimeType: 'text/markdown',
      });
      await loadWorkspaces();
    } catch (err) {
      setPullRequestActionErrorByWorkspace((prev) => ({
        ...prev,
        [activeWorkspaceId]: String(err),
      }));
    } finally {
      setPullRequestActionLoadingByWorkspace((prev) => ({
        ...prev,
        [activeWorkspaceId]: false,
      }));
    }
  }, [
    activePullRequestStatus,
    activeWorkspace,
    activeWorkspaceId,
    loadWorkspaces,
    sendPromptWithGeneratedAttachment,
  ]);

  const handleCancelSession = useCallback(async () => {
    if (!activeSession) {
      return;
    }
    setSendError(null);
    try {
      await invoke('cancelSession', { sessionId: activeSession.id });
      setSessionStatuses((prev) => ({ ...prev, [activeSession.id]: 'idle' }));
    } catch (err) {
      setSendError(String(err));
    }
  }, [activeSession]);

  const handleResetToTurn = useCallback(
    async (turnId?: number) => {
      if (!activeSession || !activeWorkspaceId || turnId === undefined) {
        return;
      }
      if (hasAnyRunningSessions) {
        setSessionErrors((prev) => ({
          ...prev,
          [activeSession.id]:
            'Stop running sessions in this workspace before resetting.',
        }));
        return;
      }
      const confirmed = globalThis.confirm?.(
        'Reset to this point? This will discard all messages and code changes after this turn and delete untracked files created after this point (gitignored files are preserved).',
      );
      if (!confirmed) {
        return;
      }
      setSendError(null);
      setSessionErrors((prev) => ({ ...prev, [activeSession.id]: null }));
      setResettingTurnId(turnId);
      setSessionStatuses((prev) => ({ ...prev, [activeSession.id]: 'running' }));
      try {
        await invoke('resetSessionToTurn', {
          sessionId: activeSession.id,
          turnId,
        });
        await loadSessionMessages(activeSession.id);
        await loadSessionAttachments(activeSession.id);
        await loadSessions();
        await loadGitStatus(activeWorkspaceId);
        const selectedDiff = selectedDiffPathByWorkspace[activeWorkspaceId] ?? null;
        await loadWorkspaceDiff(activeWorkspaceId, selectedDiff);
        setPlanModeBySession((prev) => ({ ...prev, [activeSession.id]: false }));
      } catch (err) {
        setSessionErrors((prev) => ({
          ...prev,
          [activeSession.id]: String(err),
        }));
      } finally {
        setSessionStatuses((prev) => ({ ...prev, [activeSession.id]: 'idle' }));
        setResettingTurnId(null);
      }
    },
    [
      activeSession,
      activeWorkspaceId,
      hasAnyRunningSessions,
      loadGitStatus,
      loadSessionAttachments,
      loadSessionMessages,
      loadSessions,
      loadWorkspaceDiff,
      selectedDiffPathByWorkspace,
    ],
  );

  const handlePermissionModeChange = useCallback(
    async (mode: string) => {
      if (!activeSession) {
        return;
      }
      const previousMode = permissionModeBySession[activeSession.id] ?? 'default';
      setPermissionModeBySession((prev) => ({ ...prev, [activeSession.id]: mode }));
      if (activeSession.agentType !== 'claude') {
        return;
      }
      try {
        await invoke('updatePermissionMode', {
          sessionId: activeSession.id,
          permissionMode: mode,
        });
      } catch (err) {
        setSendError(String(err));
        setPermissionModeBySession((prev) => ({
          ...prev,
          [activeSession.id]: previousMode,
        }));
      }
    },
    [activeSession, permissionModeBySession],
  );

  const handleModelSelection = useCallback(
    async (modelId: string) => {
      const agentForModel = MODEL_LOOKUP.agentById.get(modelId);
      if (!agentForModel) {
        return;
      }
      if (activeSession) {
        if (activeSession.agentType !== agentForModel) {
          return;
        }
        const previousModel = activeSession.model ?? null;
        setSessionsByWorkspace((prev) => {
          const list = prev[activeSession.workspaceId] ?? [];
          return {
            ...prev,
            [activeSession.workspaceId]: list.map((session) =>
              session.id === activeSession.id
                ? { ...session, model: modelId }
                : session,
            ),
          };
        });
        try {
          await invoke('updateSessionModel', {
            sessionId: activeSession.id,
            model: modelId,
          });
        } catch (err) {
          setSendError(String(err));
          setSessionsByWorkspace((prev) => {
            const list = prev[activeSession.workspaceId] ?? [];
            return {
              ...prev,
              [activeSession.workspaceId]: list.map((session) =>
                session.id === activeSession.id
                  ? { ...session, model: previousModel }
                  : session,
              ),
            };
          });
        }
        return;
      }
      setNewChatAgentType(agentForModel);
      setNewChatModelByAgent((prev) => ({
        ...prev,
        [agentForModel]: modelId,
      }));
    },
    [activeSession],
  );

  const resetComposerSuggestions = useCallback(() => {
      setComposerSuggestions([]);
      setComposerSuggestionIndex(0);
      setComposerSuggestionRange(null);
  }, []);

  const updateComposerSuggestions = useCallback(
    (value: string, cursor: number) => {
      const before = value.slice(0, cursor);
      const mentionMatch = /(^|\s)@([^\s]*)$/.exec(before);
      if (mentionMatch) {
        const query = mentionMatch[2] ?? '';
        const start = cursor - query.length - 1;
        const queryLower = query.toLowerCase();
        const matches = workspaceFiles
          .filter((path) => path.toLowerCase().includes(queryLower))
          .slice(0, 8)
          .map((path) => ({
            id: `mention-${path}`,
            label: path,
            value: `@${path}`,
            mode: 'mention' as const,
            description: 'File',
          }));
        setComposerSuggestions(matches);
        setComposerSuggestionIndex(0);
        setComposerSuggestionRange({ start, end: cursor });
        return;
      }
      const slashMatch = /(^|\s)\/([^\s]*)$/.exec(before);
      if (slashMatch) {
        const query = slashMatch[2] ?? '';
        const start = cursor - query.length - 1;
        const queryLower = query.toLowerCase();
        const uniqueCommands = Array.from(new Set(slashCommands));
        const matches = uniqueCommands
          .filter((command) => command.toLowerCase().includes(queryLower))
          .slice(0, 8)
          .map((command) => ({
            id: `slash-${command}`,
            label: `/${command}`,
            value: `/${command}`,
            mode: 'slash' as const,
            description: 'Command',
          }));
        setComposerSuggestions(matches);
        setComposerSuggestionIndex(0);
        setComposerSuggestionRange({ start, end: cursor });
        return;
      }
      resetComposerSuggestions();
    },
    [resetComposerSuggestions, slashCommands, workspaceFiles],
  );

  const applyComposerSuggestion = useCallback(
    (suggestion: ComposerSuggestion) => {
      if (!composerSuggestionRange) {
        return;
      }
      const start = composerSuggestionRange.start;
      const end = composerSuggestionRange.end;
      const nextValue =
        composerValue.slice(0, start) +
        suggestion.value +
        composerValue.slice(end);
      setComposerValue(nextValue);
      resetComposerSuggestions();
      requestAnimationFrame(() => {
        if (!composerRef.current) {
          return;
        }
        const cursor = start + suggestion.value.length;
        composerRef.current.focus();
        composerRef.current.setSelectionRange(cursor, cursor);
      });
    },
    [composerSuggestionRange, composerValue, resetComposerSuggestions],
  );

  const handleComposerChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const nextValue = event.target.value;
      setComposerValue(nextValue);
      const cursor = event.target.selectionStart ?? nextValue.length;
      updateComposerSuggestions(nextValue, cursor);
    },
    [updateComposerSuggestions],
  );

  const handleComposerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (composerSuggestions.length > 0 && composerSuggestionRange) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setComposerSuggestionIndex((prev) =>
            Math.min(prev + 1, composerSuggestions.length - 1),
          );
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setComposerSuggestionIndex((prev) => Math.max(prev - 1, 0));
          return;
        }
        if (event.key === 'Tab' || event.key === 'Enter') {
          event.preventDefault();
          const selected =
            composerSuggestions[composerSuggestionIndex] ??
            composerSuggestions[0];
          if (selected) {
            applyComposerSuggestion(selected);
          }
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          resetComposerSuggestions();
          return;
        }
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void handleSendMessage();
      }
    },
    [
      applyComposerSuggestion,
      composerSuggestionIndex,
      composerSuggestionRange,
      composerSuggestions,
      handleSendMessage,
      resetComposerSuggestions,
    ],
  );

  const handleAddAttachments = useCallback(
    async (files: FileList | File[]) => {
      if (!activeWorkspaceId) {
        return;
      }
      const nextFiles = Array.from(files ?? []);
      if (nextFiles.length === 0) {
        return;
      }
      let session = activeSession;
      if (!session) {
        try {
          session = await createSessionForWorkspace(
            activeWorkspaceId,
            newChatAgentType,
            newChatModelByAgent[newChatAgentType] ??
              getDefaultModel(newChatAgentType),
          );
        } catch {
          return;
        }
      }
      const tasks = nextFiles.map(async (file) => {
        const buffer = await file.arrayBuffer();
        const bytes = Array.from(new Uint8Array(buffer));
        return invoke<AttachmentRecord>('createAttachment', {
          sessionId: session.id,
          fileName: file.name,
          mimeType: file.type || undefined,
          bytes,
        });
      });
      const results = await Promise.allSettled(tasks);
      const created: AttachmentRecord[] = [];
      let errorMessage: string | null = null;
      for (const result of results) {
        if (result.status === 'fulfilled') {
          created.push(result.value);
        } else {
          errorMessage = String(result.reason);
        }
      }
      if (created.length > 0) {
        setDraftAttachmentsBySession((prev) => {
          const existing = prev[session.id] ?? [];
          return {
            ...prev,
            [session.id]: [...existing, ...created],
          };
        });
      }
      if (errorMessage) {
        setSendError(errorMessage);
      }
    },
    [
      activeSession,
      activeWorkspaceId,
      createSessionForWorkspace,
      newChatAgentType,
      newChatModelByAgent,
    ],
  );

  const handleRemoveDraftAttachment = useCallback(
    async (sessionId: string, attachmentId: string) => {
      try {
        await invoke('deleteAttachment', { attachmentId });
        setDraftAttachmentsBySession((prev) => {
          const existing = prev[sessionId] ?? [];
          return {
            ...prev,
            [sessionId]: existing.filter((item) => item.id !== attachmentId),
          };
        });
      } catch (err) {
        setSendError(String(err));
      }
    },
    [],
  );

  const handleSaveLinkedIssue = useCallback(() => {
    const trimmed = linkIssueValue.trim();
    if (!trimmed) {
      setLinkIssueOpen(false);
      setLinkIssueValue('');
      return;
    }
    if (activeSession) {
      setLinkedIssueBySession((prev) => ({
        ...prev,
        [activeSession.id]: trimmed,
      }));
    } else {
      setPendingIssueId(trimmed);
    }
    setLinkIssueOpen(false);
    setLinkIssueValue('');
  }, [activeSession, linkIssueValue]);

  const handleCopyMessage = useCallback(async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      return;
    }
  }, []);

  const handleComposerDragOver = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (!composerDragActive) {
        setComposerDragActive(true);
      }
    },
    [composerDragActive],
  );

  const handleComposerDragLeave = useCallback(() => {
    if (composerDragActive) {
      setComposerDragActive(false);
    }
  }, [composerDragActive]);

  const handleComposerDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setComposerDragActive(false);
      if (event.dataTransfer?.files?.length) {
        void handleAddAttachments(event.dataTransfer.files);
      }
    },
    [handleAddAttachments],
  );

  const handleResolveAskUserQuestion = useCallback(async () => {
    if (!activeAskRequest) {
      return;
    }
    try {
      await invoke('respondAskUserQuestion', {
        requestId: activeAskRequest.requestId,
        answers: askAnswers,
      });
      setPendingAskQueue((prev) => prev.slice(1));
      setAskAnswers([]);
    } catch (err) {
      setSendError(String(err));
    }
  }, [activeAskRequest, askAnswers]);
  const handleCancelAskUserQuestion = useCallback(async () => {
    if (!activeAskRequest) {
      return;
    }
    try {
      await invoke('respondAskUserQuestion', {
        requestId: activeAskRequest.requestId,
        answers: ['USER_CANCELLED'],
      });
      setPendingAskQueue((prev) => prev.slice(1));
      setAskAnswers([]);
    } catch (err) {
      setSendError(String(err));
    }
  }, [activeAskRequest]);

  const handleResolveExitPlanMode = useCallback(
    async (approved: boolean) => {
      if (!activeExitRequest) {
        return;
      }
      try {
        await invoke('respondExitPlanMode', {
          requestId: activeExitRequest.requestId,
          approved,
          turnId: null,
        });
        setPendingExitQueue((prev) => prev.slice(1));
        setPlanModeBySession((prev) => ({
          ...prev,
          [activeExitRequest.sessionId]: false,
        }));
      } catch (err) {
        setSendError(String(err));
      }
    },
    [activeExitRequest],
  );

  const handleCreateTerminal = useCallback(
    async (workspaceId: string, focusAfterCreate = false) => {
      setTerminalErrorByWorkspace((prev) => ({ ...prev, [workspaceId]: null }));
      try {
        const terminalId = await invoke<string>('createTerminal', {
          workspaceId,
          cols: 80,
          rows: 24,
        });
        setTerminalSessionsByWorkspace((prev) => {
          const list = prev[workspaceId] ?? [];
          const next = [
            ...list,
            { id: terminalId, label: `Terminal ${list.length + 1}` },
          ];
          return { ...prev, [workspaceId]: next };
        });
        setActiveTerminalByWorkspace((prev) => ({
          ...prev,
          [workspaceId]: terminalId,
        }));
        if (focusAfterCreate) {
          setTerminalFocusToken((prev) => prev + 1);
        }
      } catch (err) {
        setTerminalErrorByWorkspace((prev) => ({
          ...prev,
          [workspaceId]: String(err),
        }));
      }
    },
    [],
  );

  const handleFocusTerminal = useCallback(() => {
    if (!activeWorkspaceId) {
      return;
    }
    setRightPanelTab('terminal');
    const sessions = terminalSessionsByWorkspace[activeWorkspaceId] ?? [];
    if (sessions.length === 0) {
      void handleCreateTerminal(activeWorkspaceId, true);
      return;
    }
    setActiveTerminalByWorkspace((prev) => ({
      ...prev,
      [activeWorkspaceId]: prev[activeWorkspaceId] ?? sessions[0].id,
    }));
    setTerminalFocusToken((prev) => prev + 1);
  }, [activeWorkspaceId, handleCreateTerminal, terminalSessionsByWorkspace]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTypingTarget =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable;
      const key = event.key.toLowerCase();
      const primary = isMac ? event.metaKey : event.ctrlKey;

      if (primary && key === 'k') {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }
      if (primary && key === 'p') {
        event.preventDefault();
        setFileOpenerOpen(true);
        return;
      }
      if (primary && key === 'i') {
        event.preventDefault();
        setLinkIssueOpen(true);
        return;
      }
      if (primary && key === 't') {
        event.preventDefault();
        handleNewChat();
        return;
      }
      if (primary && event.code === 'Backquote') {
        event.preventDefault();
        handleFocusTerminal();
        return;
      }
      if (primary && key === 'b') {
        event.preventDefault();
        if (event.altKey) {
          toggleRightSidebar();
        } else {
          toggleLeftSidebar();
        }
        return;
      }
      if (primary && key === '.') {
        event.preventDefault();
        toggleZenMode();
        return;
      }
      if (!primary && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        if (isTypingTarget) {
          return;
        }
        if (event.key === '[') {
          event.preventDefault();
          toggleLeftSidebar();
        } else if (event.key === ']') {
          event.preventDefault();
          toggleRightSidebar();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    handleFocusTerminal,
    handleNewChat,
    isMac,
    toggleLeftSidebar,
    toggleRightSidebar,
    toggleZenMode,
  ]);

  const loadWorkspaceFiles = useCallback(
    async (workspaceId: string) => {
      setFileListError(null);
      try {
        const files = await invoke<string[]>('listWorkspaceFiles', { workspaceId });
        setFilesByWorkspace((prev) => ({ ...prev, [workspaceId]: files }));
      } catch (err) {
        setFileListError(String(err));
        setFilesByWorkspace((prev) => ({ ...prev, [workspaceId]: [] }));
      }
    },
    [],
  );

  useEffect(() => {
    if (activeWorkspaceId && !filesByWorkspace[activeWorkspaceId]) {
      loadWorkspaceFiles(activeWorkspaceId);
    }
    if (activeWorkspaceId) {
      setActiveTabByWorkspace((prev) => ({
        ...prev,
        [activeWorkspaceId]: prev[activeWorkspaceId] ?? 'changes',
      }));
    }
  }, [activeWorkspaceId, filesByWorkspace, loadWorkspaceFiles]);

  useEffect(() => {
    if (!activeWorkspaceId) {
      return;
    }
    setSelectedDiffPathByWorkspace((prev) => ({
      ...prev,
      [activeWorkspaceId]: prev[activeWorkspaceId] ?? null,
    }));
    const hasGitStatus = Object.prototype.hasOwnProperty.call(
      gitStatusByWorkspace,
      activeWorkspaceId,
    );
    if (!hasGitStatus) {
      loadGitStatus(activeWorkspaceId);
    }
    const hasWorkspaceDiff = Object.prototype.hasOwnProperty.call(
      workspaceDiffByWorkspace,
      activeWorkspaceId,
    );
    if (!hasWorkspaceDiff) {
      loadWorkspaceDiff(activeWorkspaceId, null);
    }
  }, [
    activeWorkspaceId,
    gitStatusByWorkspace,
    loadGitStatus,
    loadWorkspaceDiff,
    workspaceDiffByWorkspace,
  ]);

  useEffect(() => {
    if (!activeWorkspaceId || !activeWorkspace || !activeRepo) {
      return;
    }
    void loadRepoBranches(activeRepo.id);
    void loadPullRequestStatus(activeWorkspaceId);
  }, [
    activeRepo,
    activeWorkspace,
    activeWorkspaceId,
    loadPullRequestStatus,
    loadRepoBranches,
  ]);

  useEffect(() => {
    if (!activeWorkspaceId) {
      return;
    }
    const openIds = openSessionIdsByWorkspace[activeWorkspaceId] ?? [];
    const activeId = activeSessionByWorkspace[activeWorkspaceId] ?? null;
    if (openIds.length === 0) {
      if (activeId) {
        setActiveSessionByWorkspace((prev) => ({
          ...prev,
          [activeWorkspaceId]: null,
        }));
      }
      return;
    }
    if (activeId && openIds.includes(activeId)) {
      return;
    }
    setActiveSessionByWorkspace((prev) => ({
      ...prev,
      [activeWorkspaceId]: openIds[openIds.length - 1],
    }));
  }, [activeSessionByWorkspace, activeWorkspaceId, openSessionIdsByWorkspace]);

  useEffect(() => {
    setFileListVisibleCount(20);
  }, [activeWorkspaceId]);

  const handleOpenFile = useCallback(
    async (workspaceId: string, path: string) => {
      setFilePreviewError(null);
      try {
        const preview = await invoke<FilePreview>('readWorkspaceFile', {
          workspaceId,
          path,
        });
        setFilePreviewByWorkspace((prev) => ({ ...prev, [workspaceId]: preview }));
        setRecentFilesByWorkspace((prev) => {
          const existing = prev[workspaceId] ?? [];
          const next = [path, ...existing.filter((item) => item !== path)].slice(0, 8);
          return { ...prev, [workspaceId]: next };
        });
        setActiveTabByWorkspace((prev) => ({ ...prev, [workspaceId]: 'changes' }));
      } catch (err) {
        setFilePreviewError(String(err));
      }
    },
    [],
  );

  const handleSelectDiffFile = useCallback(
    async (workspaceId: string, path: string) => {
      setActiveView('workspace');
      setActiveTabByWorkspace((prev) => ({ ...prev, [workspaceId]: 'changes' }));
      setSelectedDiffPathByWorkspace((prev) => ({
        ...prev,
        [workspaceId]: path,
      }));
      await loadWorkspaceDiff(workspaceId, path);
    },
    [loadWorkspaceDiff],
  );

  const handleClearDiffSelection = useCallback(() => {
    if (!activeWorkspaceId) {
      return;
    }
    setSelectedDiffPathByWorkspace((prev) => ({
      ...prev,
      [activeWorkspaceId]: null,
    }));
    void loadWorkspaceDiff(activeWorkspaceId, null);
  }, [activeWorkspaceId, loadWorkspaceDiff]);

  const handleRefreshGitPanel = useCallback(() => {
    if (!activeWorkspaceId) {
      return;
    }
    loadGitStatus(activeWorkspaceId);
    const selected = selectedDiffPathByWorkspace[activeWorkspaceId] ?? null;
    loadWorkspaceDiff(activeWorkspaceId, selected);
    void loadPullRequestStatus(activeWorkspaceId, true);
    void loadGithubAuthStatus();
  }, [
    activeWorkspaceId,
    loadGitStatus,
    loadGithubAuthStatus,
    loadPullRequestStatus,
    loadWorkspaceDiff,
    selectedDiffPathByWorkspace,
  ]);

  const renderFileTree = useCallback(
    (nodes: FileTreeNode[], depth = 0) => {
      return nodes.map((node) => {
        if (node.isFile) {
          return (
            <button
              key={node.path}
              type="button"
              onClick={() => {
                if (!activeWorkspaceId) {
                  return;
                }
                void handleOpenFile(activeWorkspaceId, node.path);
              }}
              style={{ paddingLeft: depth * 12 }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100"
            >
              <span className="truncate">{node.name}</span>
            </button>
          );
        }
        return (
          <div key={node.path}>
            <div
              style={{ paddingLeft: depth * 12 }}
              className="flex items-center gap-2 px-2 py-1 text-xs font-semibold text-slate-400"
            >
              <span className="truncate">{node.name}</span>
            </div>
            {node.children ? (
              <div className="space-y-1">{renderFileTree(node.children, depth + 1)}</div>
            ) : null}
          </div>
        );
      });
    },
    [activeWorkspaceId, handleOpenFile],
  );

  const handleRunScript = useCallback(async () => {
    if (!activeWorkspaceId || !runScript) {
      return;
    }
    setRunErrorByWorkspace((prev) => ({ ...prev, [activeWorkspaceId]: null }));
    setRunStatusByWorkspace((prev) => ({
      ...prev,
      [activeWorkspaceId]: 'running',
    }));
    setRunOutputByWorkspace((prev) => {
      const existing = prev[activeWorkspaceId] ?? [];
      const entry = createRunOutputEntry(
        'stdout',
        'Starting run script...',
      );
      const next = [...existing, entry];
      return { ...prev, [activeWorkspaceId]: next };
    });
    try {
      await invoke('startRunScript', { workspaceId: activeWorkspaceId });
    } catch (err) {
      setRunStatusByWorkspace((prev) => ({
        ...prev,
        [activeWorkspaceId]: 'idle',
      }));
      setRunErrorByWorkspace((prev) => ({
        ...prev,
        [activeWorkspaceId]: String(err),
      }));
    }
  }, [activeWorkspaceId, runScript]);

  const handleStopRunScript = useCallback(async () => {
    if (!activeWorkspaceId) {
      return;
    }
    try {
      await invoke('stopRunScript', { workspaceId: activeWorkspaceId });
    } catch (err) {
      setRunErrorByWorkspace((prev) => ({
        ...prev,
        [activeWorkspaceId]: String(err),
      }));
    }
  }, [activeWorkspaceId]);

  const handleSelectTerminal = useCallback((workspaceId: string, terminalId: string) => {
    setActiveTerminalByWorkspace((prev) => ({ ...prev, [workspaceId]: terminalId }));
  }, []);

  const handleCloseTerminal = useCallback(
    async (workspaceId: string, terminalId: string) => {
      try {
        await invoke('closeTerminal', { terminalId });
      } catch (err) {
        setTerminalErrorByWorkspace((prev) => ({
          ...prev,
          [workspaceId]: String(err),
        }));
      }
      let remainingSessions: TerminalSession[] = [];
      setTerminalSessionsByWorkspace((prev) => {
        const list = prev[workspaceId] ?? [];
        remainingSessions = list.filter((session) => session.id !== terminalId);
        return { ...prev, [workspaceId]: remainingSessions };
      });
      setActiveTerminalByWorkspace((activePrev) => {
        if (activePrev[workspaceId] !== terminalId) {
          return activePrev;
        }
        return {
          ...activePrev,
          [workspaceId]: remainingSessions[0]?.id ?? null,
        };
      });
    },
    [],
  );

  const requestArchiveWorkspace = (workspace: WorkspaceInfo) => {
    const repo = repos.find((item) => item.id === workspace.repoId);
    const script = repo?.scriptsArchive?.trim();
    if (script) {
      setArchiveConfirmWorkspace(workspace);
      setArchiveConfirmScript(script);
      setArchiveConfirmOpen(true);
      return;
    }
    void handleArchiveWorkspace(workspace, false);
  };

  const closeArchiveConfirm = useCallback(() => {
    setArchiveConfirmOpen(false);
    setArchiveConfirmWorkspace(null);
    setArchiveConfirmScript(null);
  }, []);

  const confirmArchiveWorkspace = async () => {
    if (!archiveConfirmWorkspace) {
      return;
    }
    const target = archiveConfirmWorkspace;
    closeArchiveConfirm();
    await handleArchiveWorkspace(target, true);
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
  const archiveConfirmRepo = useMemo(() => {
    if (!archiveConfirmWorkspace) {
      return null;
    }
    return repos.find((repo) => repo.id === archiveConfirmWorkspace.repoId) ?? null;
  }, [archiveConfirmWorkspace, repos]);
  const headerTitle = useMemo(() => {
    switch (activeView) {
      case 'settings':
        return 'Settings';
      case 'repo':
        return selectedRepo?.name ?? 'Repository';
      case 'workspace':
        return selectedWorkspace?.branch ?? 'Workspace';
      case 'workspaces':
        return 'Workspaces';
      case 'home':
      default:
        return 'Home';
    }
  }, [activeView, selectedRepo, selectedWorkspace]);
  const workspaceLabel = useMemo(() => {
    if (!selectedWorkspace || !selectedWorkspaceRepo) {
      return undefined;
    }
    return `${selectedWorkspaceRepo.name} · ${selectedWorkspace.branch}`;
  }, [selectedWorkspace, selectedWorkspaceRepo]);
  const commandPaletteItems = useMemo<CommandPaletteItem[]>(() => {
    const items: CommandPaletteItem[] = [
      {
        id: 'nav-home',
        label: 'Home',
        group: 'Navigation',
        onSelect: () => setActiveView('home'),
      },
      {
        id: 'nav-workspaces',
        label: 'Workspaces',
        group: 'Navigation',
        onSelect: () => setActiveView('workspaces'),
      },
      {
        id: 'nav-settings',
        label: 'Settings',
        group: 'Navigation',
        onSelect: () => setActiveView('settings'),
      },
    ];

    repos.forEach((repo) => {
      items.push({
        id: `repo-${repo.id}`,
        label: repo.name,
        description: repo.rootPath,
        group: 'Repositories',
        keywords: [repo.remoteUrl ?? ''],
        onSelect: () => {
          setSelectedRepoId(repo.id);
          setActiveView('repo');
        },
      });
    });

    workspaces.forEach((workspace) => {
      const repoName = repos.find((repo) => repo.id === workspace.repoId)?.name ?? 'Repository';
      items.push({
        id: `workspace-${workspace.id}`,
        label: workspace.branch,
        description: `${repoName} · ${workspace.state === 'archived' ? 'Archived' : 'Active'}`,
        group: 'Workspaces',
        onSelect: () => {
          void handleSelectWorkspace(workspace);
        },
      });
    });

    Object.values(sessionsByWorkspace).flat().forEach((session) => {
      const workspace = workspaces.find((item) => item.id === session.workspaceId);
      const repoName = workspace
        ? repos.find((repo) => repo.id === workspace.repoId)?.name ?? 'Repository'
        : 'Workspace';
      const title = session.title ?? 'Chat';
      const modelLabel =
        getModelLabel(session.model) ?? formatAgentLabel(session.agentType);
      const label = workspace ? `${title}` : title;
      const description = workspace
        ? `${repoName} · ${workspace.branch} · ${modelLabel}`
        : modelLabel;
      items.push({
        id: `session-${session.id}`,
        label,
        description,
        group: 'Sessions',
        onSelect: () => handleSelectSession(session.workspaceId, session.id),
      });
    });

    const settingsSections = [
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
    settingsSections.forEach((section) => {
      items.push({
        id: `settings-${section}`,
        label: section,
        group: 'Settings',
        description: 'Settings section',
        onSelect: () => setActiveView('settings'),
      });
    });

    return items;
  }, [handleSelectSession, handleSelectWorkspace, repos, sessionsByWorkspace, workspaces]);

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
    if (!archiveConfirmOpen) {
      return;
    }
    const modal = archiveConfirmRef.current;
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
        closeArchiveConfirm();
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
  }, [archiveConfirmOpen, closeArchiveConfirm]);

  useEffect(() => {
    if (!activeAskRequest) {
      return;
    }
    const modal = askUserRef.current;
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
        void handleCancelAskUserQuestion();
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
  }, [activeAskRequest, handleCancelAskUserQuestion]);

  useEffect(() => {
    if (!activeExitRequest) {
      return;
    }
    const modal = exitPlanRef.current;
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
        void handleResolveExitPlanMode(false);
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
  }, [activeExitRequest, handleResolveExitPlanMode]);

  useEffect(() => {
    if (!historyOpen) {
      return;
    }
    const modal = historyRef.current;
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
        setHistoryOpen(false);
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
  }, [historyOpen]);

  useEffect(() => {
    if (!linkIssueOpen) {
      return;
    }
    const modal = linkIssueRef.current;
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
        setLinkIssueOpen(false);
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
  }, [linkIssueOpen]);

  useEffect(() => {
    if (!newChatOpen) {
      return;
    }
    const modal = newChatRef.current;
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
        setNewChatOpen(false);
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
  }, [newChatOpen]);

  useEffect(() => {
    if (!workspaceMenuId) {
      return;
    }
    const handleClickOutside = (event: MouseEvent) => {
      const menuEl = workspaceMenuRefs.current[workspaceMenuId] ?? null;
      if (menuEl && !menuEl.contains(event.target as Node)) {
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
  }, [workspaceMenuId]);

  return (
    <TooltipProvider>
      <>
      <div className="flex h-screen w-full bg-slate-950 text-slate-100">
      {showLeftSidebar ? (
        <>
          <aside
            className="flex h-full flex-shrink-0 flex-col border-r border-slate-800 bg-slate-950"
            style={{ width: leftSidebarWidth }}
          >
            <div className="border-b border-slate-800 px-4 py-4">
              <div className="text-lg font-semibold">Supertree</div>
              <div className="mt-3 flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => setActiveView('home')}
                  className={`rounded-md px-3 py-2 text-left text-sm transition ${
                    activeView === 'home'
                      ? 'bg-slate-800 text-slate-100'
                      : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100'
                  }`}
                >
                  Home
                </button>
                <button
                  type="button"
                  onClick={() => setActiveView('workspaces')}
                  className={`rounded-md px-3 py-2 text-left text-sm transition ${
                    activeView === 'workspaces'
                      ? 'bg-slate-800 text-slate-100'
                      : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100'
                  }`}
                >
                  Workspaces
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto px-4 py-4">
              <div className="text-xs uppercase tracking-[0.2em] text-slate-500">
                Repositories
              </div>
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
                      <div
                        key={repo.id}
                        className="rounded-md border border-slate-800/60 bg-slate-950/60"
                      >
                        <div className="flex items-center justify-between gap-2 px-3 py-2">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedRepoId(repo.id);
                              setActiveView('repo');
                            }}
                            className={`text-left text-sm font-medium transition ${
                              isSelected
                                ? 'text-slate-100'
                                : 'text-slate-300 hover:text-slate-100'
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
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => openCreateWorkspace(repo)}
                              >
                                New workspace
                              </Button>
                            </div>
                            {repoWorkspaces.length === 0 ? (
                              <div className="mt-2 text-xs text-slate-500">
                                No workspaces yet.
                              </div>
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
                                        className={`flex flex-1 items-center gap-2 text-left text-xs transition ${
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
                                          workspaceMenuRefs.current[workspace.id] = node;
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
                                                requestArchiveWorkspace(workspace);
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

            <div className="border-t border-slate-800 px-4 py-4">
              <div className="flex flex-col gap-2">
                <Button variant="outline" onClick={() => setAddRepoOpen(true)}>
                  Add repository
                </Button>
                <Button variant="outline" onClick={() => setActiveView('settings')}>
                  Settings
                </Button>
              </div>
              <div className="mt-3 text-xs text-slate-500">M04 shell</div>
            </div>
          </aside>
          <div
            role="separator"
            aria-orientation="vertical"
            onMouseDown={startLeftResize}
            className="group relative h-full w-1 flex-shrink-0 cursor-col-resize bg-transparent"
          >
            <div className="absolute inset-y-0 left-0 w-px bg-slate-800 transition group-hover:bg-slate-500" />
          </div>
        </>
      ) : null}

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-slate-800 bg-slate-950">
          <div className="flex items-center justify-between gap-4 px-4 py-2">
            <div className="flex min-w-0 items-center gap-2 overflow-x-auto">
              <button
                type="button"
                disabled={!activeWorkspaceId}
                onClick={() => {
                  if (!activeWorkspaceId) {
                    return;
                  }
                  setActiveView('workspace');
                  setActiveTabByWorkspace((prev) => ({
                    ...prev,
                    [activeWorkspaceId]: 'changes',
                  }));
                }}
                className={`rounded-md px-3 py-1.5 text-sm transition ${
                  !activeWorkspaceId
                    ? 'cursor-not-allowed text-slate-600'
                    : activeTab === 'changes'
                      ? 'bg-slate-800 text-slate-100'
                      : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100'
                }`}
              >
                All changes
              </button>
              {activeSessions.map((session) => {
                const isActive =
                  activeTab === 'session' && activeSessionId === session.id;
                const title = session.title ?? 'Chat';
                const modelLabel =
                  getModelLabel(session.model) ??
                  formatAgentLabel(session.agentType);
                return (
                  <div
                    key={session.id}
                    title="Middle-click to close"
                    onMouseDown={(event) => {
                      if (event.button === 1) {
                        event.preventDefault();
                        handleCloseSession(session.workspaceId, session.id);
                      }
                    }}
                    className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition ${
                      isActive
                        ? 'bg-slate-800 text-slate-100'
                        : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        handleSelectSession(session.workspaceId, session.id)
                      }
                      className="flex items-center gap-2 truncate"
                    >
                      <span className="truncate">{title}</span>
                      <span className="text-[10px] uppercase tracking-widest text-slate-500">
                        {modelLabel}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleCloseSession(session.workspaceId, session.id);
                      }}
                      className="text-slate-500 transition hover:text-slate-100"
                      aria-label="Close chat"
                    >
                      ×
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                disabled={!activeWorkspaceId}
                onClick={handleNewChat}
                className={`rounded-md px-3 py-1.5 text-sm transition ${
                  !activeWorkspaceId
                    ? 'cursor-not-allowed text-slate-600'
                    : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100'
                }`}
              >
                + New chat
              </button>
              <select
                aria-label="New chat agent"
                value={newChatAgentType}
                onChange={(event) =>
                  setNewChatAgentType(event.target.value as 'claude' | 'codex')
                }
                className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1 text-[11px] uppercase tracking-widest text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
              {activeView !== 'workspace' ? (
                <div className="ml-3 text-xs uppercase tracking-[0.2em] text-slate-600">
                  {headerTitle}
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setHistoryOpen(true)}
                    className="rounded-md border border-slate-800 px-3 py-1.5 text-xs text-slate-400 transition hover:bg-slate-900 hover:text-slate-100"
                  >
                    History
                  </button>
                </TooltipTrigger>
                <TooltipContent>View chat history</TooltipContent>
              </Tooltip>
              <button
                type="button"
                onClick={() => setCommandPaletteOpen(true)}
                className="rounded-md border border-slate-800 px-3 py-1.5 text-xs text-slate-400 transition hover:bg-slate-900 hover:text-slate-100"
              >
                {isMac ? 'Cmd+K' : 'Ctrl+K'}
              </button>
              <button
                type="button"
                onClick={() => setFileOpenerOpen(true)}
                className="rounded-md border border-slate-800 px-3 py-1.5 text-xs text-slate-400 transition hover:bg-slate-900 hover:text-slate-100"
              >
                {isMac ? 'Cmd+P' : 'Ctrl+P'}
              </button>
            </div>
          </div>
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
          {fileListError ? (
            <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {fileListError}
            </div>
          ) : null}
          {filePreviewError ? (
            <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {filePreviewError}
            </div>
          ) : null}
          {activeGitStatusError ? (
            <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {activeGitStatusError}
            </div>
          ) : null}
          {activeWorkspaceDiffError ? (
            <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {activeWorkspaceDiffError}
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
              <div className="space-y-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="text-xs uppercase tracking-[0.3em] text-slate-500">
                      Workspace
                    </div>
                    <div className="mt-2 text-lg font-semibold">
                      {workspaceLabel ?? 'Workspace'}
                    </div>
                    {selectedWorkspace.path ? (
                      <div className="mt-1 text-xs text-slate-500">
                        {selectedWorkspace.path}
                      </div>
                    ) : null}
                  </div>
                  <div className="text-xs text-slate-500">
                    {workspaceFiles.length} files
                  </div>
                </div>

                {activeTab === 'changes' ? (
                  <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)]">
                    <div className="rounded-lg border border-slate-800 bg-slate-950/60">
                      <div className="border-b border-slate-800 px-4 py-3">
                        <div className="text-xs uppercase tracking-[0.3em] text-slate-500">
                          File tree
                        </div>
                        <div className="mt-1 text-xs text-slate-500">
                          {workspaceFiles.length > 0
                            ? `${workspaceFiles.length} files`
                            : 'No files loaded.'}
                        </div>
                      </div>
                      <div className="max-h-[360px] overflow-auto px-3 py-3 text-xs">
                        {workspaceFileTree.length === 0 ? (
                          <div className="text-sm text-slate-500">
                            No files loaded.
                          </div>
                        ) : (
                          <div className="space-y-1">
                            {renderFileTree(workspaceFileTree)}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="rounded-lg border border-slate-800 bg-slate-950/60">
                      <div className="border-b border-slate-800 px-4 py-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-xs uppercase tracking-[0.3em] text-slate-500">
                              Diff preview
                            </div>
                            <div className="mt-1 text-xs text-slate-500">
                              {selectedDiffPath
                                ? `Diff for ${selectedDiffPath}`
                                : 'Unified diff for all changes'}
                            </div>
                          </div>
                          {selectedDiffPath ? (
                            <button
                              type="button"
                              onClick={handleClearDiffSelection}
                              className="rounded-md border border-slate-800 px-2 py-1 text-[11px] text-slate-400 transition hover:bg-slate-900 hover:text-slate-100"
                            >
                              Show all
                            </button>
                          ) : null}
                        </div>
                      </div>
                      <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap px-4 py-3 text-xs text-slate-200">
                        {activeWorkspaceDiffLoading
                          ? 'Loading diff...'
                          : activeWorkspaceDiff.trim()
                            ? activeWorkspaceDiff
                            : 'No changes detected.'}
                      </pre>
                    </div>
                    <div className="rounded-lg border border-slate-800 bg-slate-950/60">
                      <div className="border-b border-slate-800 px-4 py-3">
                        <div className="text-xs uppercase tracking-[0.3em] text-slate-500">
                          File preview
                        </div>
                        {filePreview ? (
                          <div className="mt-1 text-xs text-slate-500">
                            {filePreview.path}
                            {filePreview.binary
                              ? ' (binary)'
                              : filePreview.truncated
                                ? ' (truncated)'
                                : ''}
                          </div>
                        ) : (
                          <div className="mt-1 text-xs text-slate-500">
                            Open a file to preview.
                          </div>
                        )}
                      </div>
                      <div className="max-h-[360px] overflow-auto px-4 py-3 text-xs text-slate-200">
                        {filePreview ? (
                          filePreview.binary ? (
                            <div className="text-sm text-slate-500">
                              Binary file preview is not available.
                            </div>
                          ) : (
                            <>
                              <pre className="whitespace-pre-wrap">
                                {filePreview.content}
                              </pre>
                              {filePreview.truncated ? (
                                <div className="mt-3 text-xs text-amber-400">
                                  Preview truncated. Open the file in an editor for the full content.
                                </div>
                              ) : null}
                            </>
                          )
                        ) : (
                          <div className="text-sm text-slate-500">
                            Use {isMac ? 'Cmd+P' : 'Ctrl+P'} to open a file.
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ) : activeSession ? (
                  <div className="flex h-full flex-col gap-4">
                    <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <div className="text-xs uppercase tracking-[0.3em] text-slate-500">
                            Chat
                          </div>
                          <div className="mt-2 text-sm text-slate-200">
                            {(activeSession.title ?? 'Chat')}{' '}
                            <span className="text-xs uppercase tracking-widest text-slate-500">
                              {getModelLabel(activeSession.model) ??
                                formatAgentLabel(activeSession.agentType)}
                            </span>
                          </div>
                          <div className="mt-2 text-xs text-slate-500">
                            Status: {activeSessionStatus}
                            {activePlanMode ? ' · Plan mode' : ''}
                          </div>
                          {linkedIssueBySession[activeSession.id] ? (
                            <div className="mt-2 text-xs text-slate-500">
                              Linked issue:{' '}
                              <span className="text-slate-200">
                                {linkedIssueBySession[activeSession.id]}
                              </span>
                            </div>
                          ) : null}
                        </div>
                        <div className="flex items-center gap-2 text-xs text-slate-500">
                          <span className="rounded-full border border-slate-800 px-2 py-1 uppercase tracking-widest">
                            {activeSession.agentType}
                          </span>
                          {contextUsagePercent !== null ? (
                            <span className="rounded-full border border-slate-800 px-2 py-1 uppercase tracking-widest">
                              Context {contextUsagePercent}%
                            </span>
                          ) : null}
                        </div>
                      </div>
                      {activeSessionError ? (
                        <div className="mt-3 text-sm text-red-400">
                          {activeSessionError}
                        </div>
                      ) : null}
                      {sendError ? (
                        <div className="mt-2 text-sm text-amber-400">{sendError}</div>
                      ) : null}
                      {sessionListError ? (
                        <div className="mt-2 text-sm text-amber-400">
                          {sessionListError}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex-1 space-y-4 overflow-auto rounded-lg border border-slate-800 bg-slate-950/40 p-4">
                      {activeSessionMessages.length === 0 ? (
                        <div className="text-sm text-slate-500">
                          No messages yet. Start the conversation below.
                        </div>
                      ) : (
                        activeSessionMessages.map((message) => {
                          const rawToolSummary =
                            message.metadata &&
                            typeof message.metadata === 'object' &&
                            'toolSummary' in message.metadata
                              ? (message.metadata as Record<string, unknown>)['toolSummary']
                              : null;
                          const toolSummary =
                            rawToolSummary && typeof rawToolSummary === 'object'
                              ? (Object.fromEntries(
                                  Object.entries(
                                    rawToolSummary as Record<string, unknown>,
                                  ).flatMap(([tool, value]) => {
                                    const count =
                                      typeof value === 'number'
                                        ? value
                                        : Number(value);
                                    return Number.isFinite(count)
                                      ? [[tool, count]]
                                      : [];
                                  }),
                                ) as Record<string, number>)
                              : null;
                          const toolEntries = toolSummary
                            ? Object.entries(toolSummary)
                            : [];
                          const diffStatRaw =
                            message.metadata &&
                            typeof message.metadata === 'object' &&
                            'diffStat' in message.metadata
                              ? (message.metadata as Record<string, unknown>)['diffStat']
                              : null;
                          const diffStat =
                            typeof diffStatRaw === 'string' ? diffStatRaw : null;
                          const diffRaw =
                            message.metadata &&
                            typeof message.metadata === 'object' &&
                            'diff' in message.metadata
                              ? (message.metadata as Record<string, unknown>)['diff']
                              : null;
                          const diffText =
                            typeof diffRaw === 'string' ? diffRaw : null;
                          const diffExpanded = diffText
                            ? diffHistoryExpandedByMessage[message.id] ?? false
                            : false;
                          const diffLines = diffStat
                            ? diffStat
                                .trim()
                                .split('\n')
                                .filter((line) => line.trim().length > 0)
                            : [];
                          const diffSummary =
                            diffLines.length > 0
                              ? diffLines[diffLines.length - 1]
                              : null;
                          const diffFiles =
                            diffLines.length > 1
                              ? diffLines.slice(0, -1)
                              : [];
                          const attachments = activeSessionAttachments.filter(
                            (item) => item.sessionMessageId === message.id,
                          );
                          const canResetMessage =
                            message.role === 'user' &&
                            message.turnId !== undefined &&
                            Boolean(message.checkpointId) &&
                            activeSession?.agentType === 'claude' &&
                            !hasAnyRunningSessions;
                          const isResetting = resettingTurnId === message.turnId;
                          return (
                            <div
                              key={message.id}
                              className={`group rounded-lg border p-4 ${
                                message.role === 'user'
                                  ? 'border-slate-800 bg-slate-900/60'
                                  : 'border-slate-800 bg-slate-950/70'
                              }`}
                            >
                              <div className="flex items-center justify-between text-[11px] uppercase tracking-widest text-slate-500">
                                <div className="flex items-center gap-2">
                                  <span>{message.role}</span>
                                  {message.streaming ? (
                                    <span className="text-emerald-400">Streaming…</span>
                                  ) : null}
                                </div>
                                <div className="flex items-center gap-2">
                                  {canResetMessage ? (
                                    <button
                                      type="button"
                                      onClick={() => handleResetToTurn(message.turnId)}
                                      disabled={isResetting}
                                      title="Reset to this point"
                                      aria-label="Reset to this point"
                                      className="rounded-md border border-slate-800 px-2 py-1 text-[10px] uppercase tracking-widest text-slate-500 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100 disabled:cursor-not-allowed disabled:opacity-40 hover:bg-slate-900 hover:text-slate-100"
                                    >
                                      ↺
                                    </button>
                                  ) : null}
                                  <button
                                    type="button"
                                    onClick={() => handleCopyMessage(message.content)}
                                    className="rounded-md border border-slate-800 px-2 py-1 text-[10px] uppercase tracking-widest text-slate-500 transition hover:bg-slate-900 hover:text-slate-100"
                                  >
                                    Copy
                                  </button>
                                </div>
                              </div>
                              <div className="mt-2 space-y-2">
                                {renderMarkdownContent(
                                  message.content,
                                  workspaceFileSet,
                                  (path) => {
                                    if (activeWorkspaceId) {
                                      void handleOpenFile(activeWorkspaceId, path);
                                    }
                                  },
                                )}
                              </div>
                              {attachments.length > 0 ? (
                                <div className="mt-3 flex flex-wrap gap-2">
                                  {attachments.map((attachment) => (
                                    <span
                                      key={attachment.id}
                                      className="inline-flex items-center gap-1 rounded-full border border-slate-800 px-2 py-1 text-[11px] text-slate-300"
                                    >
                                      📎{' '}
                                      {attachment.title ??
                                        attachment.path ??
                                        'Attachment'}
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                              {toolEntries.length > 0 ? (
                                <div className="mt-3 flex flex-wrap gap-2">
                                  {toolEntries.map(([tool, count]) => (
                                    <span
                                      key={tool}
                                      className="rounded-full border border-slate-800 px-2 py-1 text-[11px] text-slate-400"
                                    >
                                      {tool} · {count}
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                              {message.role === 'assistant' && diffStat ? (
                                <div className="mt-3 rounded-md border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-400">
                                  <div className="text-[10px] uppercase tracking-[0.3em] text-slate-500">
                                    Files changed
                                  </div>
                                  {diffSummary ? (
                                    <div className="mt-1 text-slate-300">
                                      {diffSummary}
                                    </div>
                                  ) : null}
                                  {diffFiles.length > 0 ? (
                                    <pre className="mt-2 whitespace-pre-wrap text-[11px] text-slate-500">
                                      {diffFiles.join('\n')}
                                    </pre>
                                  ) : null}
                                </div>
                              ) : null}
                              {message.role === 'assistant' && diffText ? (
                                <div className="mt-3 rounded-md border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-400">
                                  <div className="flex items-center justify-between">
                                    <div className="text-[10px] uppercase tracking-[0.3em] text-slate-500">
                                      Turn diff
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() =>
                                        setDiffHistoryExpandedByMessage((prev) => ({
                                          ...prev,
                                          [message.id]: !diffExpanded,
                                        }))
                                      }
                                      className="rounded-md border border-slate-800 px-2 py-1 text-[10px] uppercase tracking-widest text-slate-500 transition hover:bg-slate-900 hover:text-slate-100"
                                    >
                                      {diffExpanded ? 'Hide' : 'Show'}
                                    </button>
                                  </div>
                                  {diffExpanded ? (
                                    <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-[11px] text-slate-300">
                                      {diffText}
                                    </pre>
                                  ) : (
                                    <div className="mt-2 text-[11px] text-slate-500">
                                      Diff captured for this turn.
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
                ) : (
                  <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-6">
                    <div className="text-xs uppercase tracking-[0.3em] text-slate-500">
                      Chat
                    </div>
                    <div className="mt-2 text-sm text-slate-400">
                      Start a new chat to talk with Claude or Codex.
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-md border border-slate-800 bg-slate-900/40 p-4 text-sm text-slate-400">
                Select a workspace from the sidebar to view its details.
              </div>
            )
          ) : (
            <div className="space-y-6">
              <div>
                <div className="text-xs uppercase tracking-[0.3em] text-slate-500">
                  Home
                </div>
                <h1 className="mt-2 text-2xl font-semibold">Workspace overview</h1>
                <p className="mt-2 text-sm text-slate-400">
                  This is the Tauri + React shell for Supertree. The panels match the final
                  layout and the backend command is wired through.
                </p>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
                <div className="text-xs uppercase tracking-widest text-slate-500">
                  Backend
                </div>
                <div className="mt-2 text-sm">
                  {error ? `Error: ${error}` : `Rust says: ${greeting}`}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-slate-800 px-6 py-4">
          <div className="flex items-center justify-between text-xs uppercase tracking-widest text-slate-500">
            <span>Composer</span>
            <span>
              {activeWorkspaceId
                ? activeSessionStatus === 'running'
                  ? 'Running'
                  : 'Ready'
                : 'Select a workspace to start'}
              {contextUsagePercent !== null ? ` · Context ${contextUsagePercent}%` : ''}
            </span>
          </div>
          <section
            aria-label="Composer dropzone"
            className="relative mt-3 space-y-3"
            onDragOver={handleComposerDragOver}
            onDragLeave={handleComposerDragLeave}
            onDrop={handleComposerDrop}
          >
            {composerDragActive ? (
              <div className="absolute inset-0 z-10 flex items-center justify-center rounded-md border-2 border-dashed border-slate-700 bg-slate-950/90 text-sm text-slate-200">
                Drop files to attach
              </div>
            ) : null}
            <textarea
              ref={composerRef}
              value={composerValue}
              onChange={handleComposerChange}
              onKeyDown={handleComposerKeyDown}
              onBlur={resetComposerSuggestions}
              disabled={!activeWorkspaceId}
              rows={3}
              placeholder={
                activeWorkspaceId
                  ? 'Send a prompt to the agent...'
                  : 'Select a workspace to start chatting.'
              }
              className="w-full resize-none rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 disabled:cursor-not-allowed disabled:text-slate-600"
            />
            {composerSuggestions.length > 0 ? (
              <div className="rounded-md border border-slate-800 bg-slate-950/90 p-2">
                <div className="space-y-1">
                  {composerSuggestions.map((suggestion, index) => (
                    <button
                      key={suggestion.id}
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        applyComposerSuggestion(suggestion);
                      }}
                      className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-xs transition ${
                        index === composerSuggestionIndex
                          ? 'bg-slate-800 text-slate-100'
                          : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100'
                      }`}
                    >
                      <span>{suggestion.label}</span>
                      <span className="text-[10px] uppercase tracking-widest text-slate-500">
                        {suggestion.description}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {activeDraftAttachments.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {activeDraftAttachments.map((attachment) => (
                  <div
                    key={attachment.id}
                    className="inline-flex items-center gap-2 rounded-full border border-slate-800 px-2 py-1 text-[11px] text-slate-300"
                  >
                    <span>
                      📎 {attachment.title ?? attachment.path ?? 'Attachment'}
                    </span>
                    {activeSessionId ? (
                      <button
                        type="button"
                        onClick={() =>
                          handleRemoveDraftAttachment(
                            activeSessionId,
                            attachment.id,
                          )
                        }
                        className="text-slate-500 transition hover:text-slate-200"
                      >
                        ✕
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
                {activeSession ? (
                  <span>
                    Session:{' '}
                    <span className="text-slate-200">
                      {activeSession.title ?? 'Chat'}
                    </span>
                  </span>
                ) : (
                  <span>
                    New chat agent:{' '}
                    <span className="text-slate-200">
                      {formatAgentLabel(newChatAgentType)}
                    </span>
                  </span>
                )}
                <label className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-slate-500">
                  Model
                  <select
                    value={selectedModelId ?? ''}
                    onChange={(event) => handleModelSelection(event.target.value)}
                    className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1 text-[11px] uppercase tracking-widest text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
                  >
                  {modelGroupsForSelection.map((group) => (
                    <optgroup key={group.id} label={group.label}>
                      {group.models.map((model) => (
                        <option
                          key={model.id}
                          value={model.id}
                          disabled={
                            activeSession
                              ? activeSession.agentType !== group.id
                              : false
                          }
                        >
                          {model.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                  </select>
                </label>
                {activeSession?.agentType === 'claude' ? (
                  <label className="flex items-center gap-2 text-[11px] uppercase tracking-widest text-slate-500">
                    Permission
                    <select
                      value={activePermissionMode}
                      onChange={(event) =>
                        handlePermissionModeChange(event.target.value)
                      }
                      className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1 text-[11px] uppercase tracking-widest text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
                    >
                      <option value="default">Default</option>
                      <option value="plan">Plan</option>
                      <option value="acceptEdits">Accept edits</option>
                      <option value="bypassPermissions">Bypass</option>
                      <option value="delegate">Delegate</option>
                      <option value="dontAsk">Don't ask</option>
                    </select>
                  </label>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <input
                  ref={attachmentInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    const files = event.target.files;
                    if (files && files.length > 0) {
                      void handleAddAttachments(files);
                    }
                    event.target.value = '';
                  }}
                />
                <Button
                  variant="outline"
                  onClick={() => attachmentInputRef.current?.click()}
                  disabled={!activeWorkspaceId}
                >
                  📎 Attach
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setLinkIssueOpen(true)}
                  disabled={!activeWorkspaceId}
                >
                  Link issue
                </Button>
                {canCancelSession ? (
                  <Button variant="outline" onClick={handleCancelSession}>
                    Stop
                  </Button>
                ) : null}
                <Button onClick={handleSendMessage} disabled={!canSendMessage}>
                  {activeSessionStatus === 'running' ? 'Running...' : 'Send'}
                </Button>
              </div>
            </div>
          </section>
        </div>
      </main>

      {showRightSidebar ? (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            onMouseDown={startRightResize}
            className="group relative h-full w-1 flex-shrink-0 cursor-col-resize bg-transparent"
          >
            <div className="absolute inset-y-0 right-0 w-px bg-slate-800 transition group-hover:bg-slate-500" />
          </div>
          <aside
            className="flex h-full flex-shrink-0 flex-col border-l border-slate-800 bg-slate-950"
            style={{ width: rightSidebarWidth }}
          >
            <div className="border-b border-slate-800 p-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">Version control</div>
                <div className="text-xs text-slate-500">
                  {activeWorkspaceId ? 'Workspace' : 'No workspace'}
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  disabled={
                    !activeWorkspaceId || !githubReady || activePullRequestActionLoading
                  }
                  onClick={handleCreatePullRequest}
                >
                  Create PR
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!activeWorkspaceId}
                  onClick={handleReviewChanges}
                >
                  Review
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!activeWorkspaceId}
                  onClick={handleRefreshGitPanel}
                >
                  Refresh
                </Button>
              </div>
              {githubAuthLoading ? (
                <div className="mt-3 rounded-md border border-slate-800 bg-slate-900/40 px-3 py-2 text-xs text-slate-400">
                  Checking GitHub authentication...
                </div>
              ) : githubAuthStatus &&
                (!githubAuthStatus.available || !githubAuthStatus.authenticated) ? (
                <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                  {githubAuthStatus.message ??
                    'GitHub CLI is not authenticated. Run `gh auth login` to enable PR features.'}
                </div>
              ) : null}
              {activeWorkspaceId ? (
                <div className="mt-3 space-y-3 text-xs text-slate-400">
                  <label className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] uppercase tracking-[0.3em] text-slate-500">
                      Targeting
                    </span>
                    <select
                      value={activeTargetBranch ?? ''}
                      onChange={(event) => handleSetTargetBranch(event.target.value)}
                      disabled={targetBranchOptions.length === 0}
                      className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1 text-[11px] uppercase tracking-widest text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
                    >
                      {targetBranchOptions.length === 0 ? (
                        <option value="">No branches</option>
                      ) : (
                        targetBranchOptions.map((branch) => (
                          <option key={branch} value={branch}>
                            origin/{branch}
                          </option>
                        ))
                      )}
                    </select>
                  </label>
                  <div className="rounded-md border border-slate-800 bg-slate-950/40 p-3">
                    <div className="text-[10px] uppercase tracking-[0.3em] text-slate-500">
                      Pull request
                    </div>
                    {activePullRequestLoading ? (
                      <div className="mt-2 text-xs text-slate-500">
                        Loading PR status...
                      </div>
                    ) : activePullRequestUrl ? (
                      <div className="mt-2 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-sm text-slate-200">
                            PR {activePullRequestNumber ? `#${activePullRequestNumber}` : ''}
                          </div>
                          <button
                            type="button"
                            onClick={() => handleCopyMessage(activePullRequestUrl)}
                            className="rounded-md border border-slate-800 px-2 py-1 text-[10px] uppercase tracking-widest text-slate-500 transition hover:bg-slate-900 hover:text-slate-100"
                          >
                            Copy link
                          </button>
                        </div>
                        <div className="truncate text-[11px] text-slate-500">
                          {activePullRequestUrl}
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2 text-xs text-slate-500">No PR yet.</div>
                    )}
                    {reviewDecisionLabel ? (
                      <div className="mt-2 text-xs text-slate-400">
                        Review: {reviewDecisionLabel}
                      </div>
                    ) : null}
                    {checksSummaryText ? (
                      <div className="mt-2 text-xs text-slate-400">
                        Checks: {checksSummaryText}
                      </div>
                    ) : null}
                    {hasFailingChecks ? (
                      <div className="mt-3">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!githubReady || activePullRequestActionLoading}
                          onClick={handleFixErrors}
                        >
                          Fix Errors
                        </Button>
                      </div>
                    ) : null}
                    {hasChangesRequested ? (
                      <div className="mt-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!githubReady || activePullRequestActionLoading}
                          onClick={handleFetchComments}
                        >
                          Fetch comments
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  {activePullRequestActionError ? (
                    <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                      {activePullRequestActionError}
                    </div>
                  ) : null}
                  {activePullRequestError ? (
                    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                      {activePullRequestError}
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={() => setGitPanelTab('changes')}
                  className={`rounded-md px-3 py-1.5 text-xs transition ${
                    gitPanelTab === 'changes'
                      ? 'bg-slate-800 text-slate-100'
                      : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100'
                  }`}
                >
                  Changes
                </button>
                <button
                  type="button"
                  onClick={() => setGitPanelTab('files')}
                  className={`rounded-md px-3 py-1.5 text-xs transition ${
                    gitPanelTab === 'files'
                      ? 'bg-slate-800 text-slate-100'
                      : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100'
                  }`}
                >
                  All files
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto p-4">
              {gitPanelTab === 'changes' ? (
                !activeWorkspaceId ? (
                  <div className="text-sm text-slate-500">
                    Select a workspace to see changes.
                  </div>
                ) : activeGitStatusLoading ? (
                  <div className="text-sm text-slate-500">Loading changes...</div>
                ) : activeGitStatus.length === 0 ? (
                  <div className="text-sm text-slate-500">No changes yet.</div>
                ) : (
                  <div className="space-y-2">
                    {activeGitStatus.map((entry) => {
                      const additions =
                        entry.additions === null ? '—' : `+${entry.additions}`;
                      const deletions =
                        entry.deletions === null ? '—' : `-${entry.deletions}`;
                      return (
                        <button
                          key={entry.path}
                          type="button"
                          onClick={() => {
                            if (!activeWorkspaceId) {
                              return;
                            }
                            void handleSelectDiffFile(activeWorkspaceId, entry.path);
                          }}
                          className="flex w-full items-center justify-between gap-2 rounded-md border border-slate-800 px-2 py-2 text-left text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100"
                        >
                          <div className="min-w-0">
                            <div className="truncate">{entry.path}</div>
                            <div className="mt-1 text-[10px] uppercase tracking-widest text-slate-500">
                              {formatGitStatus(entry)}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2 text-[10px] text-slate-400">
                            <span className="text-emerald-400">{additions}</span>
                            <span className="text-rose-400">{deletions}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )
              ) : !activeWorkspaceId ? (
                <div className="text-sm text-slate-500">
                  Select a workspace to browse files.
                </div>
              ) : workspaceFiles.length === 0 ? (
                <div className="text-sm text-slate-500">No files loaded.</div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-[11px] text-slate-500">
                    <span>
                      Showing {visibleFileCount} of {workspaceFiles.length} files
                    </span>
                    {fileListIsTruncated ? (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          aria-label="Show more files"
                          onClick={() =>
                            setFileListVisibleCount((prev) =>
                              Math.min(prev + 20, workspaceFiles.length),
                            )
                          }
                          className="rounded-md border border-slate-800 px-2 py-1 text-[11px] text-slate-400 transition hover:bg-slate-900 hover:text-slate-100"
                        >
                          Show more
                        </button>
                        <button
                          type="button"
                          aria-label="Show all files"
                          onClick={() =>
                            setFileListVisibleCount(workspaceFiles.length)
                          }
                          className="rounded-md border border-slate-800 px-2 py-1 text-[11px] text-slate-400 transition hover:bg-slate-900 hover:text-slate-100"
                        >
                          Show all
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <div className="space-y-2">
                    {workspaceFiles.slice(0, visibleFileCount).map((file) => (
                      <button
                        key={file}
                        type="button"
                        onClick={() => {
                          if (!activeWorkspaceId) {
                            return;
                          }
                          void handleOpenFile(activeWorkspaceId, file);
                          setActiveView('workspace');
                        }}
                        className="w-full rounded-md px-2 py-1 text-left text-xs text-slate-300 hover:bg-slate-900 hover:text-slate-100"
                      >
                        {file}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="border-t border-slate-800 p-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">Run / Terminal</div>     
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setRightPanelTab('run')}
                    className={`rounded-md px-3 py-1.5 text-xs transition ${
                      rightPanelTab === 'run'
                        ? 'bg-slate-800 text-slate-100'
                        : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100'
                    }`}
                  >
                    Run
                  </button>
                  <button
                    type="button"
                    onClick={() => setRightPanelTab('terminal')}
                    className={`rounded-md px-3 py-1.5 text-xs transition ${
                      rightPanelTab === 'terminal'
                        ? 'bg-slate-800 text-slate-100'
                        : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100'
                    }`}
                  >
                    Terminal
                  </button>
                </div>
              </div>
              <div className="mt-3 space-y-3">
                {rightPanelTab === 'run' ? (
                  <>
                    <div className="flex items-center justify-between text-xs text-slate-400">
                      <span className="truncate">
                        {activeWorkspaceId
                          ? runScript
                            ? `Script: ${runScript}`
                            : 'No run script configured.'
                          : 'Select a workspace to run scripts.'}
                      </span>
                      <Button
                        size="sm"
                        variant={activeRunStatus === 'running' ? 'outline' : 'default'}
                        disabled={!activeWorkspaceId || !runScript}
                        onClick={
                          activeRunStatus === 'running'
                            ? handleStopRunScript
                            : handleRunScript
                        }
                        className={
                          activeRunStatus === 'running'
                            ? 'border-red-500/40 text-red-200 hover:bg-red-500/10'
                            : undefined
                        }
                      >
                        {activeRunStatus === 'running' ? 'Stop' : 'Run'}
                      </Button>
                    </div>
                    {activeRunError ? (
                      <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                        {activeRunError}
                      </div>
                    ) : null}
                    <div className="h-40 overflow-auto rounded-md border border-slate-800 bg-slate-900/40 p-3 text-xs text-slate-200">
                      {activeRunOutput.length === 0 ? (
                        <div className="text-slate-500">
                          Run output will appear here.
                        </div>
                      ) : (
                        <div className="space-y-1 font-mono">
                          {activeRunOutput.map((entry) => (
                            <div
                              key={entry.id}
                              className={
                                entry.stream === 'stderr'
                                  ? 'text-amber-300'
                                  : 'text-slate-200'
                              }
                            >
                              {entry.line}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    {activeTerminalError ? (
                      <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                        {activeTerminalError}
                      </div>
                    ) : null}
                    {!activeWorkspaceId ? (
                      <div className="rounded-md border border-slate-800 bg-slate-900/40 p-3 text-xs text-slate-500">
                        Select a workspace to open terminals.
                      </div>
                    ) : (
                      <TerminalPanel
                        sessions={activeTerminalSessions}
                        activeSessionId={activeTerminalId}
                        onSelect={(terminalId) =>
                          handleSelectTerminal(activeWorkspaceId, terminalId)
                        }
                        onClose={(terminalId) =>
                          handleCloseTerminal(activeWorkspaceId, terminalId)
                        }
                        onCreate={() =>
                          handleCreateTerminal(activeWorkspaceId, true)
                        }
                        focusToken={terminalFocusToken}
                      />
                    )}
                  </>
                )}
              </div>
            </div>
          </aside>
        </>
      ) : null}
    </div>

    <CommandPalette
      open={commandPaletteOpen}
      items={commandPaletteItems}
      onOpenChange={setCommandPaletteOpen}
    />
    <FileOpener
      open={fileOpenerOpen}
      files={workspaceFiles}
      recentFiles={recentFiles}
      workspaceLabel={workspaceLabel}
      onOpenChange={setFileOpenerOpen}
      onOpenFile={(path) => {
        if (!activeWorkspaceId) {
          return;
        }
        setActiveView('workspace');
        void handleOpenFile(activeWorkspaceId, path);
      }}
    />

      {archiveConfirmOpen && archiveConfirmWorkspace ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-6">
          <div
            ref={archiveConfirmRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="archive-workspace-title"
            className="w-full max-w-lg rounded-lg border border-slate-800 bg-slate-950 p-6 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-[0.3em] text-slate-500">
                  Workspace
                </div>
                <h2 id="archive-workspace-title" className="mt-2 text-xl font-semibold">
                  Archive workspace
                </h2>
                <div className="mt-1 text-xs text-slate-400">
                  {archiveConfirmRepo?.name ?? 'Unknown repository'} -{' '}
                  {archiveConfirmWorkspace.branch}
                </div>
              </div>
              <button
                type="button"
                onClick={closeArchiveConfirm}
                className="text-sm text-slate-400 hover:text-slate-100"
              >
                Close
              </button>
            </div>

            <div className="mt-4 space-y-3 text-sm text-slate-300">
              <p>
                This repository defines an archive script. Review it before continuing. The
                script runs inside the workspace and can modify files.
              </p>
              {archiveConfirmScript ? (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                  The script below will run if you confirm.
                </div>
              ) : null}
            </div>

            {archiveConfirmScript ? (
              <div className="mt-4 rounded-md border border-slate-800 bg-slate-900/60 p-3">
                <div className="text-[10px] uppercase tracking-widest text-slate-500">
                  Archive script
                </div>
                <pre className="mt-2 whitespace-pre-wrap text-xs text-slate-200">
                  {archiveConfirmScript}
                </pre>
              </div>
            ) : null}

            <div className="mt-6 flex items-center justify-end gap-2">
              <Button variant="outline" onClick={closeArchiveConfirm}>
                Cancel
              </Button>
              <Button onClick={confirmArchiveWorkspace}>Archive and run script</Button>
            </div>
          </div>
        </div>
      ) : null}

      {activeAskRequest ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-6">
          <div
            ref={askUserRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="ask-user-title"
            className="w-full max-w-lg rounded-lg border border-slate-800 bg-slate-950 p-6 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-[0.3em] text-slate-500">
                  Claude needs input
                </div>
                <h2 id="ask-user-title" className="mt-2 text-xl font-semibold">
                  Answer questions
                </h2>
              </div>
            </div>

            <div className="mt-4 space-y-4">
              {activeAskRequest.questions.map((question, index) => (
                <div key={index}>
                  <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">
                    Question {index + 1} of {activeAskRequest.questions.length}
                  </div>
                  <div className="mt-2 text-sm text-slate-200">{question.question}</div>
                  <select
                    value={askAnswers[index] ?? ''}
                    onChange={(event) => {
                      const value = event.target.value;
                      setAskAnswers((prev) => {
                        const next = [...prev];
                        next[index] = value;
                        return next;
                      });
                    }}
                    className="mt-2 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
                  >
                    {question.options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <div className="mt-6 flex items-center justify-end gap-2">
              <Button variant="outline" onClick={handleCancelAskUserQuestion}>
                Cancel
              </Button>
              <Button onClick={handleResolveAskUserQuestion}>Send response</Button>
            </div>
          </div>
        </div>
      ) : null}

      {activeExitRequest ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-6">
          <div
            ref={exitPlanRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="exit-plan-title"
            className="w-full max-w-md rounded-lg border border-slate-800 bg-slate-950 p-6 shadow-2xl"
          >
            <div className="text-xs uppercase tracking-[0.3em] text-slate-500">
              Plan review
            </div>
            <h2 id="exit-plan-title" className="mt-2 text-xl font-semibold">
              Approve the plan?
            </h2>
            <p className="mt-3 text-sm text-slate-400">
              Claude has finished planning. Approve to continue, or reject to stop.
            </p>
            <div className="mt-6 flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => handleResolveExitPlanMode(false)}>
                Reject
              </Button>
              <Button onClick={() => handleResolveExitPlanMode(true)}>Approve</Button>
            </div>
          </div>
        </div>
      ) : null}

      {historyOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-6">
          <div
            ref={historyRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="history-title"
            className="w-full max-w-lg rounded-lg border border-slate-800 bg-slate-950 p-6 shadow-2xl"
          >
            <div className="text-xs uppercase tracking-[0.3em] text-slate-500">
              History
            </div>
            <h2 id="history-title" className="mt-2 text-xl font-semibold">
              Closed chats
            </h2>
            <p className="mt-3 text-sm text-slate-400">
              Reopen a recently closed tab for this workspace.
            </p>
            {closedSessions.length > 0 ? (
              <div className="mt-4 space-y-2">
                {closedSessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => {
                      handleSelectSession(session.workspaceId, session.id);
                      setHistoryOpen(false);
                    }}
                    className="flex w-full items-center justify-between rounded-md border border-slate-800 px-3 py-2 text-left text-sm text-slate-200 transition hover:bg-slate-900"
                  >
                    <span>
                      {session.title ?? 'Chat'}{' '}
                      <span className="text-xs uppercase tracking-widest text-slate-500">
                        {getModelLabel(session.model) ??
                          formatAgentLabel(session.agentType)}
                      </span>
                    </span>
                    <span className="text-[10px] uppercase tracking-widest text-slate-500">
                      {session.agentType}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="mt-4 text-sm text-slate-500">
                No recently closed chats.
              </div>
            )}
            <div className="mt-6 flex items-center justify-end">
              <Button variant="outline" onClick={() => setHistoryOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {linkIssueOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-6">
          <div
            ref={linkIssueRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="link-issue-title"
            className="w-full max-w-md rounded-lg border border-slate-800 bg-slate-950 p-6 shadow-2xl"
          >
            <div className="text-xs uppercase tracking-[0.3em] text-slate-500">
              Issue
            </div>
            <h2 id="link-issue-title" className="mt-2 text-xl font-semibold">
              Link issue
            </h2>
            <p className="mt-3 text-sm text-slate-400">
              Attach an issue ID or URL to this chat.
            </p>
            <input
              value={linkIssueValue}
              onChange={(event) => setLinkIssueValue(event.target.value)}
              placeholder="e.g. M07-14 or https://github.com/org/repo/issues/14"
              className="mt-4 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
            />
            <div className="mt-6 flex items-center justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setLinkIssueOpen(false);
                  setLinkIssueValue('');
                }}
              >
                Cancel
              </Button>
              <Button onClick={handleSaveLinkedIssue}>Save</Button>
            </div>
          </div>
        </div>
      ) : null}

      {newChatOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-6">
          <div
            ref={newChatRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-chat-title"
            className="w-full max-w-lg rounded-lg border border-slate-800 bg-slate-950 p-6 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-[0.3em] text-slate-500">
                  Chat
                </div>
                <h2 id="new-chat-title" className="mt-2 text-xl font-semibold">
                  New chat
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setNewChatOpen(false)}
                className="text-sm text-slate-400 hover:text-slate-100"
              >
                Close
              </button>
            </div>
            <div className="mt-4 space-y-4">
              <div>
                <div className="text-xs uppercase tracking-[0.3em] text-slate-500">
                  Agent
                </div>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setNewChatAgentType('claude')}
                    className={`rounded-md px-3 py-2 text-sm transition ${
                      newChatAgentType === 'claude'
                        ? 'bg-slate-800 text-slate-100'
                        : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100'
                    }`}
                  >
                    Claude
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewChatAgentType('codex')}
                    className={`rounded-md px-3 py-2 text-sm transition ${
                      newChatAgentType === 'codex'
                        ? 'bg-slate-800 text-slate-100'
                        : 'text-slate-400 hover:bg-slate-900 hover:text-slate-100'
                    }`}
                  >
                    Codex
                  </button>
                </div>
              </div>
              <label className="block text-xs uppercase tracking-[0.3em] text-slate-500">
                Model
                <select
                  value={
                    newChatModelByAgent[newChatAgentType] ??
                    getDefaultModel(newChatAgentType) ??
                    ''
                  }
                  onChange={(event) => {
                    const modelId = event.target.value;
                    const agentForModel =
                      MODEL_LOOKUP.agentById.get(modelId) ?? newChatAgentType;
                    setNewChatAgentType(agentForModel);
                    setNewChatModelByAgent((prev) => ({
                      ...prev,
                      [agentForModel]: modelId,
                    }));
                  }}
                  className="mt-2 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
                >
                  {MODEL_GROUPS.map((group) => (
                    <optgroup key={group.id} label={group.label}>
                      {group.models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              <div>
                <div className="text-xs uppercase tracking-[0.3em] text-slate-500">
                  Context
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {recentSessions.length > 0 ? (
                    recentSessions.map((session) => (
                      <button
                        key={session.id}
                        type="button"
                        onClick={() => toggleNewChatContext(session.id)}
                        className={`rounded-full border px-3 py-1 text-xs transition ${
                          newChatContextIds.includes(session.id)
                            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                            : 'border-slate-800 text-slate-400 hover:bg-slate-900 hover:text-slate-100'
                        }`}
                      >
                        {session.title ?? 'Chat'}
                      </button>
                    ))
                  ) : (
                    <div className="text-xs text-slate-500">
                      No recent chats.
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="mt-6 flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => setNewChatOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleStartNewChat}>Start chat</Button>
            </div>
          </div>
        </div>
      ) : null}

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
    </TooltipProvider>
  );
}
