import type {
  ChatSummary,
  TranscriptItem,
  ExternalSession,
  CliMayteWorker,
  AccountInfo,
  DeskSettings,
  ChatStatus
} from '@shared/protocol'

const now = Date.now()

export const accountFixtures: AccountInfo[] = [
  {
    id: 'default',
    label: 'Default (Pro)',
    configDir: null,
    email: 'jacob@example.com',
    plan: 'Pro',
    signedIn: true,
    fiveHourPct: 45,
    weeklyPct: 30,
    fiveHourResetsAt: now + 5 * 60 * 60 * 1000,
    weeklyResetsAt: now + 7 * 24 * 60 * 60 * 1000,
    inUse: true
  },
  {
    id: '68',
    label: '#68 eek (Max 20x)',
    configDir: '/path/to/eek',
    number: 68,
    email: 'eek@example.com',
    plan: 'Max 20x',
    signedIn: true,
    fiveHourPct: 15,
    weeklyPct: 8,
    fiveHourResetsAt: now + 3 * 60 * 60 * 1000,
    weeklyResetsAt: now + 6 * 24 * 60 * 60 * 1000,
    inUse: false
  }
]

const chatStatuses: ChatStatus[] = [
  'starting',
  'working',
  'needs_you',
  'idle',
  'stopped',
  'error',
  'limited',
  'closed'
]

export const chatFixtures: ChatSummary[] = [
  // Active working chat
  {
    id: 'chat-working-1',
    sessionId: 'session-001',
    title: 'Build Shell and Sidebar Components',
    cwd: '/Users/me/Desktop/Project/Agent Hydra/desk',
    account: accountFixtures[0],
    accountAuto: true,
    model: 'claude-opus-5-5',
    effort: 'high',
    permissionMode: 'acceptEdits',
    delegateToCliMayte: true,
    status: 'working',
    activity: 'Writing components/shell.ts',
    turnStartedAt: now - 2 * 60 * 1000,
    lastError: null,
    limitResetsAt: null,
    unread: false,
    pinned: true,
    archived: false,
    group: null,
    forkedFrom: null,
    createdAt: now - 24 * 60 * 60 * 1000,
    updatedAt: now - 30 * 1000,
    costUsd: 0.42,
    contextPct: 65,
    pendingCount: 0,
    queuedCount: 0,
    climayteActive: 2
  },

  // Chat needing attention
  {
    id: 'chat-needs-you-1',
    sessionId: 'session-002',
    title: 'Fix permission request handling',
    cwd: '/Users/me/Desktop/Project/Agent Hydra/desk',
    account: accountFixtures[0],
    accountAuto: true,
    model: null,
    effort: null,
    permissionMode: 'default',
    delegateToCliMayte: true,
    status: 'needs_you',
    activity: 'Waiting for permission approval',
    turnStartedAt: now - 5 * 60 * 1000,
    lastError: null,
    limitResetsAt: null,
    unread: true,
    pinned: false,
    archived: false,
    group: null,
    forkedFrom: null,
    createdAt: now - 12 * 60 * 60 * 1000,
    updatedAt: now - 1 * 1000,
    costUsd: 0.18,
    contextPct: 42,
    pendingCount: 1,
    queuedCount: 0,
    climayteActive: 0
  },

  // Unread idle chat
  {
    id: 'chat-unread-idle',
    sessionId: 'session-003',
    title: 'Implement Gallery and sections',
    cwd: '/Users/me/Desktop/Project/Agent Hydra/desk',
    account: accountFixtures[0],
    accountAuto: true,
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    permissionMode: 'acceptEdits',
    delegateToCliMayte: true,
    status: 'idle',
    activity: null,
    turnStartedAt: null,
    lastError: null,
    limitResetsAt: null,
    unread: true,
    pinned: false,
    archived: false,
    group: null,
    forkedFrom: null,
    createdAt: now - 6 * 60 * 60 * 1000,
    updatedAt: now - 3 * 60 * 60 * 1000,
    costUsd: 0.31,
    contextPct: 38,
    pendingCount: 0,
    queuedCount: 0,
    climayteActive: 0
  },

  // Read idle chat
  {
    id: 'chat-read-idle',
    sessionId: 'session-004',
    title: 'Test WebSocket reconnection',
    cwd: '/Users/me/Desktop/Project/Agent Hydra/desk',
    account: accountFixtures[0],
    accountAuto: true,
    model: 'claude-haiku-4-5',
    effort: 'low',
    permissionMode: 'bypassPermissions',
    delegateToCliMayte: false,
    status: 'idle',
    activity: null,
    turnStartedAt: null,
    lastError: null,
    limitResetsAt: null,
    unread: false,
    pinned: false,
    archived: false,
    group: null,
    forkedFrom: null,
    createdAt: now - 2 * 24 * 60 * 60 * 1000,
    updatedAt: now - 12 * 60 * 60 * 1000,
    costUsd: 0.09,
    contextPct: 22,
    pendingCount: 0,
    queuedCount: 0,
    climayteActive: 0
  },

  // Stopped chat
  {
    id: 'chat-stopped',
    sessionId: 'session-005',
    title: 'Debug notification system',
    cwd: '/Users/me/Desktop/Project/AgentHydra',
    account: accountFixtures[0],
    accountAuto: true,
    model: 'claude-opus-5-5',
    effort: null,
    permissionMode: 'default',
    delegateToCliMayte: true,
    status: 'stopped',
    activity: null,
    turnStartedAt: null,
    lastError: null,
    limitResetsAt: null,
    unread: false,
    pinned: false,
    archived: false,
    group: null,
    forkedFrom: null,
    createdAt: now - 4 * 60 * 60 * 1000,
    updatedAt: now - 2 * 60 * 60 * 1000,
    costUsd: 0.21,
    contextPct: 51,
    pendingCount: 0,
    queuedCount: 0,
    climayteActive: 0
  },

  // Error chat
  {
    id: 'chat-error',
    sessionId: 'session-006',
    title: 'Fix integration test',
    cwd: '/Users/me/Desktop/Project/other',
    account: accountFixtures[1],
    accountAuto: false,
    model: null,
    effort: null,
    permissionMode: 'plan',
    delegateToCliMayte: true,
    status: 'error',
    activity: null,
    turnStartedAt: null,
    lastError: 'API rate limit exceeded',
    limitResetsAt: null,
    unread: true,
    pinned: false,
    archived: false,
    group: null,
    forkedFrom: null,
    createdAt: now - 8 * 60 * 60 * 1000,
    updatedAt: now - 30 * 60 * 1000,
    costUsd: 0.15,
    contextPct: 29,
    pendingCount: 0,
    queuedCount: 0,
    climayteActive: 0
  },

  // Limited chat (usage limit)
  {
    id: 'chat-limited',
    sessionId: 'session-007',
    title: 'Optimize bundle size',
    cwd: '/Users/me/Desktop/nexuscode-2d',
    account: accountFixtures[1],
    accountAuto: false,
    model: 'claude-opus-5-5',
    effort: 'xhigh',
    permissionMode: 'acceptEdits',
    delegateToCliMayte: true,
    status: 'limited',
    activity: null,
    turnStartedAt: null,
    lastError: null,
    limitResetsAt: now + 2 * 60 * 60 * 1000,
    unread: true,
    pinned: false,
    archived: false,
    group: null,
    forkedFrom: null,
    createdAt: now - 3 * 60 * 60 * 1000,
    updatedAt: now - 15 * 60 * 1000,
    costUsd: 0.87,
    contextPct: 88,
    pendingCount: 0,
    queuedCount: 0,
    climayteActive: 1
  },

  // Closed chat
  {
    id: 'chat-closed',
    sessionId: null,
    title: 'Review performance metrics',
    cwd: '/Users/me/Desktop/Project/other',
    account: accountFixtures[0],
    accountAuto: true,
    model: null,
    effort: null,
    permissionMode: 'default',
    delegateToCliMayte: true,
    status: 'closed',
    activity: null,
    turnStartedAt: null,
    lastError: null,
    limitResetsAt: null,
    unread: false,
    pinned: false,
    archived: false,
    group: null,
    forkedFrom: null,
    createdAt: now - 7 * 24 * 60 * 60 * 1000,
    updatedAt: now - 7 * 24 * 60 * 60 * 1000,
    costUsd: 0.52,
    contextPct: null,
    pendingCount: 0,
    queuedCount: 0,
    climayteActive: 0
  },

  // Archived chat
  {
    id: 'chat-archived',
    sessionId: null,
    title: 'Old project setup',
    cwd: '/Users/me/Desktop/archived',
    account: accountFixtures[0],
    accountAuto: true,
    model: null,
    effort: null,
    permissionMode: 'default',
    delegateToCliMayte: false,
    status: 'closed',
    activity: null,
    turnStartedAt: null,
    lastError: null,
    limitResetsAt: null,
    unread: false,
    pinned: false,
    archived: true,
    group: null,
    forkedFrom: null,
    createdAt: now - 30 * 24 * 60 * 60 * 1000,
    updatedAt: now - 30 * 24 * 60 * 60 * 1000,
    costUsd: 0.11,
    contextPct: null,
    pendingCount: 0,
    queuedCount: 0,
    climayteActive: 0
  }
]

export const transcriptFixtures: TranscriptItem[] = [
  {
    id: 'msg-user-1',
    ts: now - 5 * 60 * 1000,
    kind: 'user',
    text: 'Build the shell and sidebar components for Hydra Desk'
  },
  {
    id: 'msg-thinking-1',
    ts: now - 4 * 60 * 1000,
    kind: 'thinking',
    text: 'I need to implement the main layout with a sidebar on the left and the main content area on the right. The sidebar should show chats grouped by project...',
    streaming: false
  },
  {
    id: 'msg-assistant-1',
    ts: now - 3 * 60 * 1000,
    kind: 'assistant_text',
    text: "I'll create the shell and sidebar components. Let me start with the main App.vue layout.",
    streaming: false
  },
  {
    id: 'tool-read-1',
    ts: now - 2 * 60 * 1000,
    kind: 'tool_use',
    name: 'Read',
    input: { file_path: '/Users/me/Desktop/Project/Agent Hydra/desk/SPEC.md' },
    status: 'done',
    result: {
      text: '[File content: 325 lines, showing key specifications for the window layout...]',
      isError: false
    },
    startedAt: now - 2 * 60 * 1000,
    endedAt: now - 2 * 60 * 1000 + 500
  },
  {
    id: 'tool-write-1',
    ts: now - 100 * 1000,
    kind: 'tool_use',
    name: 'Write',
    input: {
      file_path: '/Users/me/Desktop/Project/Agent Hydra/desk/web/src/App.vue',
      content: '<script setup lang="ts">...</script>...'
    },
    status: 'done',
    result: {
      text: 'File written',
      isError: false
    },
    startedAt: now - 100 * 1000,
    endedAt: now - 100 * 1000 + 200
  },
  {
    id: 'tool-bash-1',
    ts: now - 80 * 1000,
    kind: 'tool_use',
    name: 'Bash',
    input: { command: 'bun run --cwd web typecheck' },
    status: 'running',
    progress: 'Checking TypeScript...',
    startedAt: now - 80 * 1000
  },
  {
    id: 'perm-1',
    ts: now - 60 * 1000,
    kind: 'permission',
    toolName: 'Edit',
    toolUseId: undefined,
    input: { file_path: '/Users/me/Desktop/Project/Agent Hydra/desk/web/src/stores/desk.ts' },
    blockedPath: '/Users/me/Desktop/Project/Agent Hydra/desk/web/src/stores/desk.ts',
    canAlwaysAllow: true,
    state: 'pending'
  },
  {
    id: 'question-1',
    ts: now - 45 * 1000,
    kind: 'question',
    toolUseId: undefined,
    questions: [
      {
        question: 'Should we use IndexedDB or localStorage for persisting chat drafts?',
        header: 'Storage choice',
        multiSelect: false,
        options: [
          { label: 'IndexedDB', description: 'Better for large data' },
          { label: 'localStorage', description: 'Simple and built-in' },
          { label: 'Both', description: 'localStorage as cache, IndexedDB as main' }
        ]
      }
    ],
    state: 'pending'
  },
  {
    id: 'plan-1',
    ts: now - 30 * 1000,
    kind: 'plan',
    toolUseId: undefined,
    plan: '# Implementation Plan\n\n1. Create stores/desk.ts with useDesk() hook\n2. Build shell layout with sidebar\n3. Implement notification system\n4. Add WebSocket reconnection logic',
    state: 'pending'
  },
  {
    id: 'todos-1',
    ts: now - 20 * 1000,
    kind: 'todos',
    todos: [
      { content: 'Build useDesk() store', status: 'completed' },
      { content: 'Create shell layout', status: 'in_progress' },
      { content: 'Implement sidebar', status: 'pending' },
      { content: 'Add notifications', status: 'pending' }
    ]
  },
  {
    id: 'result-1',
    ts: now - 10 * 1000,
    kind: 'result',
    ok: true,
    durationMs: 125000,
    costUsd: 0.18,
    turns: 1
  }
]

export const externalSessionFixtures: ExternalSession[] = [
  {
    id: 'session-ext-1',
    title: 'Claude Desktop: NexusCode-2D build',
    cwd: '/Users/me/Desktop/nexuscode-2d',
    source: 'desktop',
    instance: 'main',
    status: 'working',
    activity: 'Running vitest tests',
    lastActivityAt: now - 5 * 1000,
    model: 'claude-opus-5-5',
    accountId: null,
    canResume: false,
    fromPc: null,
    pinned: false,
    archived: false,
    unread: false,
    group: null
  },
  {
    id: 'session-ext-2',
    title: 'Terminal CLI: Hydra Desktop build',
    cwd: '/Users/me/Desktop/Project/Agent Hydra/desk',
    source: 'cli',
    instance: '#68 eek',
    status: 'idle',
    activity: null,
    lastActivityAt: now - 10 * 60 * 1000,
    model: 'claude-sonnet-5-5',
    accountId: 'cli-68',
    canResume: true,
    fromPc: null,
    pinned: false,
    archived: false,
    unread: false,
    group: null
  },
  {
    id: 'session-ext-3',
    title: 'Codex: Database query optimization',
    cwd: null,
    source: 'codex',
    instance: null,
    status: 'stale',
    activity: null,
    lastActivityAt: now - 2 * 60 * 60 * 1000,
    model: null,
    accountId: null,
    canResume: false,
    fromPc: null,
    pinned: false,
    archived: false,
    unread: false,
    group: null
  }
]

export const cliMayteWorkerFixtures: CliMayteWorker[] = [
  {
    id: 'worker-1',
    title: 'Integration tests for sidebar',
    group: 'Build Shell and Sidebar Components',
    status: 'running',
    active: true,
    account: '#68',
    model: 'claude-haiku-4-5',
    effort: 'low',
    kind: 'test',
    cwd: '/Users/me/Desktop/Project/Agent Hydra/desk',
    sessionId: 'session-worker-1',
    originSessionId: 'session-001',
    startedAt: now - 3 * 60 * 1000,
    endedAt: null,
    lastActivityAt: now - 5 * 1000,
    lastActivity: 'Running test suite...',
    usedPct: 2,
    tokens: 184_300,
    verdict: null,
    error: null
  },
  {
    id: 'worker-2',
    title: 'Visual regression tests',
    group: 'Build Shell and Sidebar Components',
    status: 'waiting',
    active: true,
    account: 'default',
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    kind: 'test',
    cwd: '/Users/me/Desktop/Project/Agent Hydra/desk',
    sessionId: 'session-worker-2',
    originSessionId: 'session-001',
    startedAt: now - 2 * 60 * 1000,
    endedAt: null,
    lastActivityAt: now - 10 * 1000,
    lastActivity: 'Waiting for image processing...',
    usedPct: 1,
    tokens: 61_250,
    verdict: null,
    error: null
  },
  {
    id: 'worker-3',
    title: 'Type checking components',
    group: 'Build Shell and Sidebar Components',
    status: 'done',
    active: false,
    account: 'default',
    model: 'claude-haiku-4-5',
    effort: null,
    kind: 'typecheck',
    cwd: '/Users/me/Desktop/Project/Agent Hydra/desk',
    sessionId: null,
    originSessionId: 'session-001',
    startedAt: now - 10 * 60 * 1000,
    endedAt: now - 5 * 60 * 1000,
    lastActivityAt: now - 5 * 60 * 1000,
    lastActivity: 'Completed successfully',
    usedPct: 0.5,
    tokens: 22_900,
    verdict: 'ok',
    error: null
  }
]

export const settingsFixtures: DeskSettings = {
  defaultModel: null,
  defaultEffort: 'medium',
  defaultPermissionMode: 'acceptEdits',
  defaultAccountId: 'auto',
  delegateToCliMayte: true,
  idleCloseMinutes: 30,
  notifications: true,
  projectFolders: [],
  projectRoots: [],
  hiddenProjects: []
}
