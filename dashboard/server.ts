/**
 * NanoClaw Dashboard Server
 *
 * Two-tab dashboard:
 *   Tab 1: Pixel Art Office — real-time interactive coworker visualization
 *   Tab 2: Timeline — all-time metrics, task history, analytics
 *
 * Reads NanoClaw state read-only (SQLite + IPC files + coworker-types.json).
 * Receives real-time hook events via POST /api/hook-event.
 */

import { createServer } from 'http';
import { createHash } from 'crypto';
import { exec } from 'child_process';
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, unlinkSync, mkdirSync, rmSync, copyFileSync } from 'fs';
import { join, resolve, relative, isAbsolute, extname } from 'path';
import Database from 'better-sqlite3';

/**
 * Check if `target` is inside (or equal to) `baseDir`.
 * Uses path.relative to avoid the startsWith('/foo/bar') vs '/foo/bar-evil' bug.
 * Mirrors ensureWithinBase() from src/group-folder.ts.
 */
/** Safe decodeURIComponent — returns null on malformed input instead of throwing. */
function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function isInsideDir(baseDir: string, target: string): boolean {
  const rel = relative(resolve(baseDir), resolve(target));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const PUBLIC_DIR = resolve(import.meta.dirname, 'public');
const DB_PATH = join(PROJECT_ROOT, 'store', 'messages.db');
const GROUPS_DIR = join(PROJECT_ROOT, 'groups');
const DATA_DIR = join(PROJECT_ROOT, 'data');
const SKILLS_DIR = join(PROJECT_ROOT, 'container', 'skills');
const CHANNELS_DIR = join(PROJECT_ROOT, 'src', 'channels');
const LOGS_DIR = join(PROJECT_ROOT, 'logs');
const COWORKER_TYPES_PATH = join(GROUPS_DIR, 'coworker-types.json');
const PORT = parseInt(process.env.DASHBOARD_PORT || '3737', 10);
const DASHBOARD_HOST = process.env.DASHBOARD_HOST || '0.0.0.0'; // all interfaces; set to 127.0.0.1 for localhost-only
const MAX_CONCURRENT_CONTAINERS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5);
// DASHBOARD_SECRET is read dynamically so tests can toggle it via process.env

// --- SQLite (read-only) ---

function openDb(): Database.Database | null {
  try {
    return new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch {
    console.warn(`[dashboard] Cannot open DB at ${DB_PATH} — running without DB`);
    return null;
  }
}

let db = openDb();

// Persistent write connection (lazy-opened, reused across requests)
let writeDb: Database.Database | null = null;

function getWriteDb(): Database.Database | null {
  if (writeDb) return writeDb;
  try {
    writeDb = new Database(DB_PATH, { fileMustExist: true });
    return writeDb;
  } catch {
    return null;
  }
}

// --- State snapshot ---

interface CoworkerState {
  folder: string;
  name: string;
  type: string;
  description: string;
  status: 'idle' | 'working' | 'error' | 'thinking';
  currentTask: string | null;
  lastActivity: string | null;
  taskCount: number;
  color: string;
  // live hook data
  lastToolUse: string | null;
  lastNotification: string | null;
  hookTimestamp: number | null;
  subagents: SubagentState[];
  isAutoUpdate: boolean;
  allowedMcpTools: string[];
  disallowedMcpTools: string[];
}

interface SubagentState {
  agentId: string;
  agentType: string | null;
  phase: 'active' | 'leaving';
  status: 'idle' | 'working' | 'error' | 'thinking';
  lastToolUse: string | null;
  lastNotification: string | null;
  startedAt: number;
  lastActivity: number;
  sessionId: string | null;
  exitAt: number | null;
}

interface DashboardState {
  coworkers: CoworkerState[];
  tasks: any[];
  taskRunLogs: any[];
  registeredGroups: any[];
  hookEvents: HookEvent[];
  timestamp: number;
}

interface HookEvent {
  group: string;
  event: string;
  tool?: string;
  message?: string;
  tool_input?: string;
  tool_response?: string;
  session_id?: string;
  agent_id?: string;
  agent_type?: string;
  tool_use_id?: string;
  transcript_path?: string;
  cwd?: string;
  extra?: Record<string, any>;
  timestamp: number;
}

// Ring buffer for recent hook events (live state)
const hookEvents: HookEvent[] = [];
const MAX_HOOK_EVENTS = 200;

// Hook events DB (write connection, lazy-opened)
let hookEventsDb: Database.Database | null = null;

function getHookEventsDb(): Database.Database | null {
  if (hookEventsDb) return hookEventsDb;
  try {
    const dbPath = join(PROJECT_ROOT, 'store', 'messages.db');
    hookEventsDb = new Database(dbPath, { fileMustExist: true });
    hookEventsDb.pragma('journal_mode = WAL');
    hookEventsDb.exec(`
      CREATE TABLE IF NOT EXISTS hook_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_folder TEXT NOT NULL,
        event TEXT NOT NULL,
        tool TEXT,
        tool_use_id TEXT,
        message TEXT,
        tool_input TEXT,
        tool_response TEXT,
        session_id TEXT,
        agent_id TEXT,
        agent_type TEXT,
        transcript_path TEXT,
        cwd TEXT,
        extra TEXT,
        timestamp INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_he_group ON hook_events(group_folder);
      CREATE INDEX IF NOT EXISTS idx_he_session ON hook_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_he_tool_use ON hook_events(tool_use_id);
      CREATE INDEX IF NOT EXISTS idx_he_ts ON hook_events(timestamp);
    `);
    return hookEventsDb;
  } catch {
    return null;
  }
}

// Live status from hooks (group_folder -> latest state)
const liveHookState = new Map<string, {
  tool?: string;
  notification?: string;
  status: CoworkerState['status'];
  ts: number;
  agentActive: boolean;
}>();
const liveSubagentState = new Map<string, Map<string, SubagentState>>();
const SUBAGENT_STALE_MS = 5 * 60 * 1000;
const SUBAGENT_EXIT_MS = 12 * 1000;
// Groups that have ever sent a hook event — prevents "container running + no hookState" from
// being treated as "working" after hook state expires following a Stop event.
const hookEverSeen = new Set<string>();

// Cached set of running container name prefixes (refreshed async every 5s)
const runningContainers = new Set<string>();

function refreshContainerStatus(): void {
  exec(
    'docker ps --format "{{.Names}}" 2>/dev/null',
    { timeout: 3000 },
    (_err, stdout) => {
      runningContainers.clear();
      if (stdout) {
        for (const name of stdout.trim().split('\n')) {
          if (name) runningContainers.add(name);
        }
      }
    },
  );
}

// Initial refresh + periodic update
refreshContainerStatus();
setInterval(refreshContainerStatus, 5000);

/** Check if a group folder has a running container (from cache). */
function hasRunningContainer(folder: string): boolean {
  return findRunningContainer(folder) !== null;
}

let cachedTypes: { data: Record<string, any>; mtimeMs: number } | null = null;
function getCoworkerTypes(): Record<string, any> {
  try {
    const st = statSync(COWORKER_TYPES_PATH);
    if (cachedTypes && cachedTypes.mtimeMs === st.mtimeMs) return cachedTypes.data;
    const data = JSON.parse(readFileSync(COWORKER_TYPES_PATH, 'utf-8'));
    cachedTypes = { data, mtimeMs: st.mtimeMs };
    return data;
  } catch {
    return {};
  }
}

function findRunningContainer(folder: string): string | null {
  const containerName = folder.replace(/_/g, '-');
  for (const name of runningContainers) {
    if (name.startsWith(`nanoclaw-${containerName}`)) return name;
  }
  return null;
}

// Color palette for coworker types
const TYPE_COLORS: Record<string, string> = {
  'slang-build': '#5B8DEF',
  'slang-ir': '#3B82F6',
  'slang-frontend': '#10B981',
  'slang-cuda': '#F59E0B',
  'slang-optix': '#EF4444',
  'slang-langfeat': '#8B5CF6',
  'slang-docs': '#EC4899',
  'slang-coverage': '#14B8A6',
  'slang-test': '#F97316',
};

// Full MCP tool inventories — must match container/agent-runner/src/index.ts
const MCP_ALL_TOOLS: string[] = [
  'mcp__deepwiki__read_wiki_structure',
  'mcp__deepwiki__read_wiki_contents',
  'mcp__deepwiki__ask_question',
  'mcp__slang-mcp__github_get_issue',
  'mcp__slang-mcp__github_list_issues',
  'mcp__slang-mcp__github_search_issues',
  'mcp__slang-mcp__github_list_pull_requests',
  'mcp__slang-mcp__github_get_pull_request',
  'mcp__slang-mcp__github_get_pull_request_comments',
  'mcp__slang-mcp__github_get_pull_request_reviews',
  'mcp__slang-mcp__github_create_or_update_file',
  'mcp__slang-mcp__github_get_discussions',
  'mcp__slang-mcp__gitlab_list_issues',
  'mcp__slang-mcp__gitlab_list_merge_requests',
  'mcp__slang-mcp__gitlab_get_file_contents',
  'mcp__slang-mcp__gitlab_create_or_update_file',
  'mcp__slang-mcp__discord_read_messages',
  'mcp__slang-mcp__slack_post_message',
  'mcp__slang-mcp__slack_get_channel_history',
  'mcp__slang-mcp__slack_reply_to_thread',
  'mcp__slang-mcp__slack_get_user_profile',
  'mcp__slang-mcp__slack_search_messages',
];

const BASE_TIER_TOOLS = [
  'mcp__deepwiki__ask_question',
  'mcp__slang-mcp__github_get_issue',
  'mcp__slang-mcp__github_get_pull_request',
  'mcp__slang-mcp__github_get_pull_request_comments',
  'mcp__slang-mcp__github_get_pull_request_reviews',
];

function resolveAllowedMcpTools(
  dbAllowed: string[] | null,
  coworkerType: string | null,
  isMain: boolean,
  types: Record<string, any>,
): string[] {
  if (dbAllowed && dbAllowed.length > 0) return dbAllowed;
  if (coworkerType && types[coworkerType]?.allowedMcpTools) return types[coworkerType].allowedMcpTools;
  if (isMain) return ['mcp__deepwiki__ask_question'];
  return BASE_TIER_TOOLS;
}

function computeDisallowed(allowed: string[]): string[] {
  const set = new Set(allowed);
  return MCP_ALL_TOOLS.filter(t => !set.has(t));
}

const READISH_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'TodoRead', 'NotebookRead']);
const WRITEISH_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'Bash', 'NotebookEdit', 'TodoWrite']);

function classifyToolStatus(tool: string | undefined, fallback: CoworkerState['status'] = 'working'): CoworkerState['status'] {
  if (!tool) return fallback;
  if (READISH_TOOLS.has(tool)) return 'thinking';
  if (WRITEISH_TOOLS.has(tool)) return 'working';
  return fallback;
}

function classifyEventStatus(
  event: Pick<HookEvent, 'event' | 'tool' | 'message'>,
  previous: CoworkerState['status'] = 'working',
): CoworkerState['status'] {
  if (event.event === 'PostToolUseFailure') return 'error';
  if (event.event === 'PreToolUse' || event.event === 'PostToolUse') {
    return classifyToolStatus(event.tool, previous);
  }
  if (event.event === 'Notification') {
    const msg = (event.message || '').toLowerCase();
    if (/(waiting|approval|permission|confirm|blocked|input required)/.test(msg)) return 'thinking';
  }
  if (event.event === 'SessionEnd' || event.event === 'Stop') return 'idle';
  return previous;
}

function getOrCreateGroupSubagents(group: string): Map<string, SubagentState> {
  let groupMap = liveSubagentState.get(group);
  if (!groupMap) {
    groupMap = new Map<string, SubagentState>();
    liveSubagentState.set(group, groupMap);
  }
  return groupMap;
}

function updateLiveSubagentState(event: HookEvent): void {
  if (!event.group || !event.agent_id) return;

  if (event.event === 'SubagentStart') {
    const groupMap = getOrCreateGroupSubagents(event.group);
    const previous = groupMap.get(event.agent_id);
    groupMap.set(event.agent_id, {
      agentId: event.agent_id,
      agentType: event.agent_type || previous?.agentType || null,
      phase: 'active',
      status: classifyEventStatus(event, previous?.status || 'working'),
      lastToolUse: previous?.lastToolUse || null,
      lastNotification: event.message || previous?.lastNotification || null,
      startedAt: previous?.startedAt || event.timestamp,
      lastActivity: event.timestamp,
      sessionId: event.session_id || previous?.sessionId || null,
      exitAt: null,
    });
    return;
  }

  const groupMap = liveSubagentState.get(event.group);
  if (!groupMap || !groupMap.has(event.agent_id)) return;

  if (event.event === 'SubagentStop') {
    const previous = groupMap.get(event.agent_id)!;
    groupMap.set(event.agent_id, {
      ...previous,
      phase: 'leaving',
      status: 'idle',
      lastNotification: event.message || previous.lastNotification || 'Leaving desk',
      lastActivity: event.timestamp,
      exitAt: event.timestamp + SUBAGENT_EXIT_MS,
    });
    return;
  }

  const previous = groupMap.get(event.agent_id)!;
  groupMap.set(event.agent_id, {
    agentId: event.agent_id,
    agentType: event.agent_type || previous.agentType,
    phase: 'active',
    status: classifyEventStatus(event, previous.status),
    lastToolUse: event.tool || previous.lastToolUse,
    lastNotification: event.message || previous.lastNotification,
    startedAt: previous.startedAt,
    lastActivity: event.timestamp,
    sessionId: event.session_id || previous.sessionId,
    exitAt: null,
  });
}

function getState(): DashboardState {
  const types = getCoworkerTypes();
  const coworkers: CoworkerState[] = [];

  // Scan groups/ for spawned instances (slang_* folders)
  try {
    const folders = readdirSync(GROUPS_DIR).filter(
      (f) => statSync(join(GROUPS_DIR, f)).isDirectory() && !f.startsWith('.'),
    );

    // Collect registered group folders for filtering
    const registeredFolders = new Set<string>();
    if (db) {
      try {
        const rows = db.prepare('SELECT folder FROM registered_groups').all() as { folder: string }[];
        for (const r of rows) registeredFolders.add(r.folder);
      } catch { /* ignore */ }
    }

    for (const folder of folders) {
      // Skip non-instance folders: global (shared memory), main (legacy placeholder unless registered)
      if (folder === 'global') continue;
      if (folder === 'main') continue;
      // Skip folders not registered in the DB (deleted coworkers leave stale folders)
      if (registeredFolders.size > 0 && !registeredFolders.has(folder)) continue;

      // Determine coworker type
      let type = 'unknown';
      let description = '';
      let name = folder;
      let isAutoUpdate = false;

      // Check if this is a template folder (matches a type key)
      // but allow it if it's registered as a coworker in the DB
      if (types[folder] && !registeredFolders.has(folder)) {
        continue;
      }

      // Match spawned instances (e.g., slang_ir-generics -> slang-ir type)
      for (const [typeName, typeInfo] of Object.entries(types) as [string, any][]) {
        if (folder.startsWith(typeName.replace(/-/g, '_') + '_') || folder.startsWith(typeName + '_')) {
          type = typeName;
          description = typeInfo.description || '';
          name = folder.replace(/^slang_/, '');
          isAutoUpdate = true;
          break;
        }
      }

      // Resolve type, name, and MCP tools from DB
      let dbAllowedMcp: string[] | null = null;
      let isMainGroup = false;
      if (type === 'unknown' && db) {
        try {
          const row = db.prepare('SELECT name, folder, coworker_type, allowed_mcp_tools, is_main FROM registered_groups WHERE folder = ?').get(folder) as any;
          if (row) {
            name = row.name || folder;
            isMainGroup = !!row.is_main;
            dbAllowedMcp = row.allowed_mcp_tools ? JSON.parse(row.allowed_mcp_tools) : null;
            if (row.coworker_type) {
              type = row.coworker_type;
              if (types[row.coworker_type]) {
                description = (types[row.coworker_type] as any).description || '';
                isAutoUpdate = true;
              } else {
                description = `Custom type (no template)`;
              }
            } else if (row.is_main) {
              type = 'coordinator';
              description = 'Main coordinator — orchestrates all coworkers';
            }
          }
        } catch { /* ignore */ }
      }

      // Skip non-coworker folders
      if (folder === 'global') continue;

      // Determine status from IPC and task state
      let status: CoworkerState['status'] = 'idle';
      let currentTask: string | null = null;
      let lastActivity: string | null = null;
      let taskCount = 0;

      if (db) {
        try {
          // Check for active tasks
          const activeTasks = db
            .prepare("SELECT prompt, last_run FROM scheduled_tasks WHERE group_folder = ? AND status = 'active' ORDER BY next_run LIMIT 1")
            .all(folder) as any[];
          if (activeTasks.length > 0) {
            currentTask = activeTasks[0].prompt;
            status = 'working';
          }

          // Count total tasks
          const countRow = db
            .prepare('SELECT COUNT(*) as cnt FROM scheduled_tasks WHERE group_folder = ?')
            .get(folder) as any;
          taskCount = countRow?.cnt || 0;

          // Last activity from task run logs
          const lastLog = db
            .prepare('SELECT run_at, status as log_status FROM task_run_logs WHERE task_id IN (SELECT id FROM scheduled_tasks WHERE group_folder = ?) ORDER BY run_at DESC LIMIT 1')
            .get(folder) as any;
          if (lastLog) {
            lastActivity = lastLog.run_at;
            if (lastLog.log_status === 'error') status = 'error';
          }
        } catch { /* ignore query errors */ }
      }

      // Check for active container via IPC input directory
      const inputDir = join(DATA_DIR, 'ipc', folder, 'input');
      if (existsSync(inputDir)) {
        try {
          const files = readdirSync(inputDir);
          if (files.some((f) => f.endsWith('.json'))) {
            status = 'thinking'; // has pending input
          }
        } catch { /* ignore */ }
      }

      // Use agent hook state for real-time status (preferred over container check)
      const hookState = liveHookState.get(folder);
      const containerRunning = hasRunningContainer(folder);
      if (hookState && hookState.agentActive) {
        // Agent is actively processing — use live hook-derived status.
        // No time limit: long-running tools (builds) can take minutes;
        // agentActive is cleared explicitly by Stop/SessionEnd events.
        status = hookState.status || classifyToolStatus(hookState.tool, 'working');
      } else if (status === 'idle' && containerRunning && !hookState && !hookEverSeen.has(folder)) {
        // Container running but never sent any hook events (e.g. agent just started).
        // Once a group has sent hooks, we trust the hook state lifecycle instead.
        status = 'working';
      }

      const subagents = Array.from(liveSubagentState.get(folder)?.values() || [])
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((subagent) => ({ ...subagent }));

      // If subagents are active, parent should show working
      if (status === 'idle' && subagents.length > 0) {
        status = 'working';
      }

      coworkers.push({
        folder,
        name,
        type,
        description,
        status,
        currentTask,
        lastActivity,
        taskCount,
        color: TYPE_COLORS[type] || '#6B7280',
        lastToolUse: hookState?.tool || null,
        lastNotification: hookState?.notification || null,
        hookTimestamp: hookState?.ts || null,
        subagents,
        isAutoUpdate,
        allowedMcpTools: resolveAllowedMcpTools(dbAllowedMcp, type !== 'unknown' && type !== 'coordinator' ? type : null, isMainGroup, types),
        disallowedMcpTools: [],
      });
      // Compute disallowed after push (needs allowedMcpTools)
      const last = coworkers[coworkers.length - 1];
      last.disallowedMcpTools = computeDisallowed(last.allowedMcpTools);
    }
  } catch { /* groups dir may not exist */ }

  // Add transient entries for groups that have live hook state but no folder yet
  const knownFolders = new Set(coworkers.map((c) => c.folder));
  for (const [folder, hookState] of liveHookState.entries()) {
    if (knownFolders.has(folder)) continue;
    coworkers.push({
      folder,
      name: folder,
      type: 'unknown',
      description: '',
      status: hookState.status || classifyToolStatus(hookState.tool, 'working'),
      currentTask: null,
      lastActivity: new Date(hookState.ts).toISOString(),
      taskCount: 0,
      color: '#6B7280',
      lastToolUse: hookState.tool || null,
      lastNotification: hookState.notification || null,
      isAutoUpdate: false,
      hookTimestamp: hookState.ts || null,
      subagents: Array.from(liveSubagentState.get(folder)?.values() || []),
      allowedMcpTools: BASE_TIER_TOOLS,
      disallowedMcpTools: computeDisallowed(BASE_TIER_TOOLS),
    });
  }

  // Get all tasks and run logs
  let tasks: any[] = [];
  let taskRunLogs: any[] = [];
  let registeredGroups: any[] = [];

  if (db) {
    try {
      tasks = db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC LIMIT 100').all();
      taskRunLogs = db.prepare('SELECT * FROM task_run_logs ORDER BY run_at DESC LIMIT 500').all();
      registeredGroups = db.prepare('SELECT * FROM registered_groups').all();
    } catch { /* ignore */ }
  }

  return {
    coworkers,
    tasks,
    taskRunLogs,
    registeredGroups,
    hookEvents: hookEvents.slice(-50),
    timestamp: Date.now(),
    maxConcurrentContainers: MAX_CONCURRENT_CONTAINERS,
  };
}

// --- WebSocket (manual, no external dep) ---

function computeAcceptKey(key: string): string {
  return createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-5AB5DC6552AA')
    .digest('base64');
}

const wsClients = new Set<any>();
const sseClients = new Set<import('http').ServerResponse>();

export function resetTransientDashboardStateForTests(): void {
  hookEvents.length = 0;
  liveHookState.clear();
  liveSubagentState.clear();
  wsClients.clear();
  sseClients.clear();
}

function broadcastState(): void {
  if (wsClients.size === 0 && sseClients.size === 0) return;
  const state = JSON.stringify({ type: 'state', data: getState() });
  for (const ws of wsClients) {
    try {
      const buf = Buffer.from(state);
      const frame = createWsFrame(buf);
      ws.write(frame);
    } catch {
      wsClients.delete(ws);
    }
  }
  const ssePayload = `data: ${state}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(ssePayload);
    } catch {
      sseClients.delete(client);
    }
  }
}

function createWsFrame(data: Buffer, opcode = 0x1): Buffer {
  const len = data.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

function parseWsFrame(buf: Buffer): { opcode: number; payload: Buffer; consumed: number } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let payloadLen = buf[1] & 0x7f;
  let offset = 2;
  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  if (masked) {
    if (buf.length < offset + 4 + payloadLen) return null;
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = buf[offset + i] ^ mask[i % 4];
    }
    return { opcode, payload, consumed: offset + payloadLen };
  }
  if (buf.length < offset + payloadLen) return null;
  return { opcode, payload: buf.subarray(offset, offset + payloadLen), consumed: offset + payloadLen };
}

// --- HTTP Server ---

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/**
 * Check DASHBOARD_SECRET for admin-mutating requests.
 * If DASHBOARD_SECRET is set, requires Authorization: Bearer <secret> header.
 * Hook events from containers are exempt (they use their own auth path).
 */
function requireAuth(req: import('http').IncomingMessage, res: import('http').ServerResponse): boolean {
  const secret = process.env.DASHBOARD_SECRET || '';
  if (!secret) return true; // no secret configured → open (localhost-only by default)
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${secret}`) return true;
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end('{"error":"unauthorized"}');
  return false;
}

/** Exported for testing — handles all HTTP requests. */
export function handleRequest(req: import('http').IncomingMessage, res: import('http').ServerResponse): void {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  // API: receive hook events from containers
  if (req.method === 'POST' && url.pathname === '/api/hook-event') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const raw = JSON.parse(body);
        // Normalize Claude Code's native HTTP hook payload into our HookEvent format.
        // HTTP hooks send the raw SDK JSON with different field names than our old
        // bash-script format. We accept both for backwards compatibility.
        const event: HookEvent = {
          group:
            raw.group ||
            req.headers['x-group-folder'] as string ||
            '',
          event:
            raw.event ||
            raw.hook_event_name ||
            '',
          tool:
            raw.tool ||
            raw.tool_name ||
            undefined,
          message:
            raw.message ||
            raw.notification ||
            raw.prompt ||
            undefined,
          tool_input:
            typeof raw.tool_input === 'string'
              ? raw.tool_input
              : raw.tool_input
                ? JSON.stringify(raw.tool_input)
                : undefined,
          tool_response:
            typeof raw.tool_response === 'string'
              ? raw.tool_response
              : typeof raw.tool_result === 'string'
                ? raw.tool_result
                : raw.tool_result
                  ? JSON.stringify(raw.tool_result)
                  : raw.tool_response
                    ? JSON.stringify(raw.tool_response)
                    : undefined,
          tool_use_id: raw.tool_use_id || undefined,
          session_id: raw.session_id || undefined,
          agent_id: raw.agent_id || undefined,
          agent_type: raw.agent_type || undefined,
          transcript_path:
            raw.transcript_path ||
            raw.agent_transcript_path ||
            undefined,
          cwd: raw.cwd || undefined,
          timestamp: Date.now(),
        } as HookEvent;

        // Pack additional fields into extra
        const extra: Record<string, any> = {};
        if (typeof raw.extra === 'object' && raw.extra !== null) {
          Object.assign(extra, raw.extra);
        } else if (typeof raw.extra === 'string') {
          try { Object.assign(extra, JSON.parse(raw.extra)); } catch { /* ignore */ }
        }
        // Capture event-specific fields that aren't in our core schema
        for (const key of [
          'source', 'stop_hook_active', 'files_modified', 'error_message',
          'error_code', 'error', 'is_interrupt', 'tool_count',
          'permission_mode', 'model', 'last_assistant_message',
          'compact_summary', 'trigger', 'custom_instructions',
          'teammate_name', 'team_name', 'task_id', 'task_subject',
          'task_description', 'file_path', 'memory_type', 'load_reason',
          'notification_type', 'mcp_server_name', 'permission_suggestions',
        ]) {
          if (raw[key] !== undefined && raw[key] !== null) extra[key] = raw[key];
        }
        event.extra = Object.keys(extra).length > 0 ? extra : undefined;

        // All events go into ring buffer (including PreToolUse for tool-pair correlation)
        hookEvents.push(event);
        if (hookEvents.length > MAX_HOOK_EVENTS) hookEvents.shift();

        // Persist to database
        const heDb = getHookEventsDb();
        if (heDb) {
          try {
            heDb.prepare(`INSERT INTO hook_events
              (group_folder, event, tool, tool_use_id, message, tool_input, tool_response,
               session_id, agent_id, agent_type, transcript_path, cwd, extra, timestamp)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
              event.group || '',
              event.event || '',
              event.tool || null,
              event.tool_use_id || null,
              event.message || null,
              event.tool_input || null,
              event.tool_response || null,
              event.session_id || null,
              event.agent_id || null,
              event.agent_type || null,
              event.transcript_path || null,
              event.cwd || null,
              event.extra ? JSON.stringify(event.extra) : null,
              event.timestamp,
            );
          } catch { /* DB write failure — non-fatal */ }
        }

        // Update live state
        if (event.group) {
          hookEverSeen.add(event.group);
          const prev = liveHookState.get(event.group);
          const isStopEvent = event.event === 'Stop' || event.event === 'SessionEnd';
          const isActiveEvent = !isStopEvent && event.event !== 'Notification';
          const nextStatus = classifyEventStatus(event, prev?.status || 'working');
          liveHookState.set(event.group, {
            tool: isStopEvent ? undefined : (event.tool || prev?.tool),
            notification: event.message || prev?.notification,
            status: nextStatus,
            ts: Date.now(),
            agentActive: isStopEvent ? false : (isActiveEvent || prev?.agentActive || false),
          });
        }
        updateLiveSubagentState(event);

        broadcastState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch {
        res.writeHead(400);
        res.end('{"error":"invalid json"}');
      }
    });
    return;
  }

  // API: get current state
  if (url.pathname === '/api/state') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(getState()));
    return;
  }

  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    res.write(`data: ${JSON.stringify({ type: 'state', data: getState() })}\n\n`);
    sseClients.add(res);
    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // API: get coworker types
  if (url.pathname === '/api/types') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getCoworkerTypes()));
    return;
  }

  // API: get coworker CLAUDE.md
  if (req.method === 'GET' && url.pathname.startsWith('/api/memory/')) {
    const folder = safeDecode(url.pathname.replace('/api/memory/', ''));
    if (folder === null) { res.writeHead(400); res.end('bad request'); return; }
    const mdPath = resolve(GROUPS_DIR, folder, 'CLAUDE.md');
    if (!isInsideDir(GROUPS_DIR, mdPath)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    try {
      const content = readFileSync(mdPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
    return;
  }

  // API: get hook events filtered by group
  if (url.pathname === '/api/hook-events') {
    const group = url.searchParams.get('group');
    const filtered = group
      ? hookEvents.filter((e) => e.group === group)
      : hookEvents;
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(filtered.slice(-200)));
    return;
  }

  // API: paginated hook event history from DB
  if (url.pathname === '/api/hook-events/history') {
    const heDb = getHookEventsDb();
    if (!heDb) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
      return;
    }
    const group = url.searchParams.get('group');
    const sessionId = url.searchParams.get('session_id');
    const eventFilter = url.searchParams.get('event');
    const since = url.searchParams.get('since');
    const before = url.searchParams.get('before');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 500);

    const conditions: string[] = [];
    const params: any[] = [];
    if (group) { conditions.push('group_folder = ?'); params.push(group); }
    if (sessionId) { conditions.push('session_id = ?'); params.push(sessionId); }
    if (eventFilter) { conditions.push('event = ?'); params.push(eventFilter); }
    if (since) { conditions.push('timestamp >= ?'); params.push(parseInt(since, 10)); }
    if (before) { conditions.push('timestamp < ?'); params.push(parseInt(before, 10)); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    try {
      const rows = heDb.prepare(`SELECT * FROM hook_events ${where} ORDER BY timestamp DESC LIMIT ?`).all(...params, limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: list distinct sessions from hook_events
  if (url.pathname === '/api/hook-events/sessions') {
    const heDb = getHookEventsDb();
    if (!heDb) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
      return;
    }
    const group = url.searchParams.get('group');
    try {
      const query = group
        ? `SELECT session_id, group_folder, MIN(timestamp) as first_ts, MAX(timestamp) as last_ts, COUNT(*) as event_count
           FROM hook_events WHERE session_id IS NOT NULL AND session_id != '' AND group_folder = ?
           GROUP BY session_id ORDER BY last_ts DESC LIMIT 50`
        : `SELECT session_id, group_folder, MIN(timestamp) as first_ts, MAX(timestamp) as last_ts, COUNT(*) as event_count
           FROM hook_events WHERE session_id IS NOT NULL AND session_id != ''
           GROUP BY session_id ORDER BY last_ts DESC LIMIT 50`;
      const rows = group ? heDb.prepare(query).all(group) : heDb.prepare(query).all();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: structured session flow — pairs Pre/PostToolUse, nests subagents
  if (url.pathname === '/api/hook-events/session-flow') {
    const heDb = getHookEventsDb();
    const group = url.searchParams.get('group');
    const sessionId = url.searchParams.get('session_id');
    if (!heDb || !sessionId) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"entries":[]}');
      return;
    }
    try {
      const conditions = ['session_id = ?'];
      const params: any[] = [sessionId];
      if (group) { conditions.push('group_folder = ?'); params.push(group); }
      const rows: any[] = heDb.prepare(
        `SELECT * FROM hook_events WHERE ${conditions.join(' AND ')} ORDER BY timestamp ASC`
      ).all(...params);

      // Build structured flow entries
      const entries: any[] = [];
      const preToolMap = new Map<string, any>(); // tool_use_id -> PreToolUse row
      const subagentStack: any[] = []; // nested subagent tracking

      for (const row of rows) {
        const extra = row.extra ? JSON.parse(row.extra) : {};

        if (row.event === 'SessionStart') {
          entries.push({ type: 'session_start', timestamp: row.timestamp, extra });
        } else if (row.event === 'UserPromptSubmit') {
          entries.push({ type: 'user_prompt', timestamp: row.timestamp, message: row.message || '' });
        } else if (row.event === 'PreToolUse') {
          if (row.tool_use_id) preToolMap.set(row.tool_use_id, row);
        } else if (row.event === 'PostToolUse' || row.event === 'PostToolUseFailure') {
          const pre = row.tool_use_id ? preToolMap.get(row.tool_use_id) : null;
          const duration = pre ? row.timestamp - pre.timestamp : null;
          const entry: any = {
            type: 'tool_call',
            tool: row.tool,
            tool_use_id: row.tool_use_id,
            timestamp: row.timestamp,
            duration,
            tool_input: row.tool_input,
            tool_response: row.tool_response,
            failed: row.event === 'PostToolUseFailure',
            agent_id: row.agent_id,
          };
          if (subagentStack.length > 0) {
            subagentStack[subagentStack.length - 1].children.push(entry);
          } else {
            entries.push(entry);
          }
          if (row.tool_use_id) preToolMap.delete(row.tool_use_id);
        } else if (row.event === 'SubagentStart') {
          const block: any = {
            type: 'subagent_block',
            agent_id: row.agent_id,
            agent_type: row.agent_type,
            timestamp: row.timestamp,
            children: [],
          };
          subagentStack.push(block);
        } else if (row.event === 'SubagentStop') {
          const block = subagentStack.pop();
          if (block) {
            block.end_timestamp = row.timestamp;
            block.duration = row.timestamp - block.timestamp;
            if (subagentStack.length > 0) {
              subagentStack[subagentStack.length - 1].children.push(block);
            } else {
              entries.push(block);
            }
          }
        } else if (row.event === 'PreCompact') {
          entries.push({ type: 'compact', timestamp: row.timestamp });
        } else if (row.event === 'Notification') {
          entries.push({ type: 'notification', timestamp: row.timestamp, message: row.message || '' });
        } else if (row.event === 'Stop' || row.event === 'SessionEnd') {
          entries.push({ type: 'session_end', timestamp: row.timestamp, extra });
        }
      }

      // Flush any unclosed subagent blocks
      while (subagentStack.length > 0) {
        const block = subagentStack.pop()!;
        if (subagentStack.length > 0) {
          subagentStack[subagentStack.length - 1].children.push(block);
        } else {
          entries.push(block);
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: get recent messages from SQLite (for timeline integration + admin panel)
  // Messages table: id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message
  // Group folder resolved via registered_groups.jid -> folder
  if (url.pathname === '/api/messages') {
    const group = url.searchParams.get('group'); // group folder name
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '200', 10), 500);
    const before = url.searchParams.get('before'); // ISO timestamp for pagination
    let messages: any[] = [];
    let hasMore = false;
    if (db) {
      try {
        // Join to get group_folder, add direction/body aliases for client compat
        const base = `SELECT m.*, rg.folder as group_folder,
          CASE WHEN m.is_from_me = 1 THEN 'outgoing' ELSE 'incoming' END as direction,
          m.content as body, m.timestamp as created_at
          FROM messages m LEFT JOIN registered_groups rg ON m.chat_jid = rg.jid`;
        if (group && before) {
          messages = db.prepare(`${base} WHERE rg.folder = ? AND m.timestamp < ? ORDER BY m.timestamp DESC LIMIT ?`).all(group, before, limit + 1);
        } else if (group) {
          messages = db.prepare(`${base} WHERE rg.folder = ? ORDER BY m.timestamp DESC LIMIT ?`).all(group, limit + 1);
        } else if (before) {
          messages = db.prepare(`${base} WHERE m.timestamp < ? ORDER BY m.timestamp DESC LIMIT ?`).all(before, limit + 1);
        } else {
          messages = db.prepare(`${base} ORDER BY m.timestamp DESC LIMIT ?`).all(limit + 1);
        }
        if (messages.length > limit) {
          hasMore = true;
          messages = messages.slice(0, limit);
        }
      } catch { /* messages table may not exist */ }
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ messages, hasMore }));
    return;
  }

  // API: admin overview stats
  if (url.pathname === '/api/overview') {
    const result: any = { uptime: process.uptime(), groups: { total: 0 }, tasks: { active: 0, paused: 0, completed: 0 }, messages: { total: 0 }, sessions: 0 };
    if (db) {
      try {
        result.groups.total = (db.prepare('SELECT COUNT(*) as c FROM registered_groups').get() as any)?.c || 0;
        const taskCounts = db.prepare("SELECT status, COUNT(*) as c FROM scheduled_tasks GROUP BY status").all() as any[];
        for (const r of taskCounts) {
          if (r.status === 'active') result.tasks.active = r.c;
          else if (r.status === 'paused') result.tasks.paused = r.c;
          else result.tasks.completed = r.c;
        }
        result.messages.total = (db.prepare('SELECT COUNT(*) as c FROM messages').get() as any)?.c || 0;
        result.sessions = (db.prepare('SELECT COUNT(*) as c FROM sessions').get() as any)?.c || 0;
      } catch { /* ignore */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // API: admin tasks with recent run logs
  if (url.pathname === '/api/tasks') {
    let tasks: any[] = [];
    if (db) {
      try {
        tasks = db.prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC').all() as any[];
        for (const task of tasks) {
          task.recentLogs = db.prepare('SELECT * FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT 5').all(task.id);
        }
      } catch { /* ignore */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tasks));
    return;
  }

  // API: pause task
  if (req.method === 'POST' && /^\/api\/tasks\/(\d+)\/pause$/.test(url.pathname)) {
    if (!requireAuth(req, res)) return;
    const id = url.pathname.match(/\/api\/tasks\/(\d+)\/pause/)![1];
    const wdb = getWriteDb();
    if (wdb) {
      try {
        wdb.prepare("UPDATE scheduled_tasks SET status='paused' WHERE id=?").run(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"db unavailable"}');
    }
    return;
  }

  // API: resume task
  if (req.method === 'POST' && /^\/api\/tasks\/(\d+)\/resume$/.test(url.pathname)) {
    if (!requireAuth(req, res)) return;
    const id = url.pathname.match(/\/api\/tasks\/(\d+)\/resume/)![1];
    const wdb = getWriteDb();
    if (wdb) {
      try {
        wdb.prepare("UPDATE scheduled_tasks SET status='active' WHERE id=?").run(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"db unavailable"}');
    }
    return;
  }

  // API: list sessions
  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    let sessions: any[] = [];
    if (db) {
      try {
        sessions = db.prepare('SELECT s.group_folder, s.session_id, rg.name as group_name FROM sessions s LEFT JOIN registered_groups rg ON s.group_folder = rg.folder').all();
      } catch { /* ignore */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sessions));
    return;
  }

  // API: delete sessions for a group folder
  if (req.method === 'DELETE' && /^\/api\/sessions\//.test(url.pathname)) {
    if (!requireAuth(req, res)) return;
    const folder = safeDecode(url.pathname.replace('/api/sessions/', ''));
    if (folder === null) { res.writeHead(400); res.end('bad request'); return; }
    const wdb = getWriteDb();
    if (wdb) {
      try {
        wdb.prepare('DELETE FROM sessions WHERE group_folder=?').run(folder);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"db unavailable"}');
    }
    return;
  }

  // API: list skills
  if (req.method === 'GET' && url.pathname === '/api/skills') {
    const skills: any[] = [];
    try {
      if (existsSync(SKILLS_DIR)) {
        for (const name of readdirSync(SKILLS_DIR)) {
          const skillDir = join(SKILLS_DIR, name);
          if (!statSync(skillDir).isDirectory()) continue;
          const info: any = { name, enabled: !existsSync(join(skillDir, '.disabled')), files: [] };
          const skillMd = join(skillDir, 'SKILL.md');
          if (existsSync(skillMd)) {
            const content = readFileSync(skillMd, 'utf-8');
            const titleMatch = content.match(/^#\s+(.+)/m);
            info.title = titleMatch ? titleMatch[1] : name;
            info.description = content.split('\n').find((l: string) => l.trim() && !l.startsWith('#'))?.trim() || '';
          }
          info.files = readdirSync(skillDir).filter((f: string) => !f.startsWith('.'));
          skills.push(info);
        }
      }
    } catch { /* ignore */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(skills));
    return;
  }

  // API: toggle skill enabled/disabled
  if (req.method === 'POST' && /^\/api\/skills\/[^/]+\/toggle$/.test(url.pathname)) {
    if (!requireAuth(req, res)) return;
    const name = safeDecode(url.pathname.match(/\/api\/skills\/([^/]+)\/toggle/)![1]);
    if (name === null) { res.writeHead(400); res.end('bad request'); return; }
    const skillDir = resolve(SKILLS_DIR, name);
    if (!isInsideDir(SKILLS_DIR, skillDir)) {
      res.writeHead(403);
      res.end('{"error":"forbidden"}');
      return;
    }
    const disabledFile = join(skillDir, '.disabled');
    let enabled: boolean;
    try {
      if (existsSync(disabledFile)) {
        unlinkSync(disabledFile);
        enabled = true;
      } else {
        writeFileSync(disabledFile, '');
        enabled = false;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ enabled }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: group details
  if (req.method === 'GET' && url.pathname === '/api/groups/detail') {
    let groups: any[] = [];
    if (db) {
      try {
        groups = db.prepare('SELECT * FROM registered_groups').all() as any[];
        for (const g of groups) {
          // Count sessions
          g.sessionCount = (db.prepare('SELECT COUNT(*) as c FROM sessions WHERE group_folder = ?').get(g.folder) as any)?.c || 0;
          // Read CLAUDE.md
          const mdPath = join(GROUPS_DIR, g.folder, 'CLAUDE.md');
          try {
            g.memory = readFileSync(mdPath, 'utf-8');
          } catch {
            g.memory = null;
          }
          // Check for running container (from async cache)
          g.containerRunning = hasRunningContainer(g.folder);
        }
      } catch { /* ignore */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(groups));
    return;
  }

  // API: create coworker
  if (req.method === 'POST' && url.pathname === '/api/coworkers') {
    if (!requireAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      try {
        const { name, folder, types, type, trigger } = JSON.parse(body);
        if (!name || !folder) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"error":"name and folder required"}');
          return;
        }
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(folder)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"error":"invalid folder name (alphanumeric, hyphens, underscores, 1-64 chars)"}');
          return;
        }
        if (folder === 'global' || folder === 'main') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"error":"reserved folder name"}');
          return;
        }
        const wdb = getWriteDb();
        if (!wdb) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end('{"error":"db unavailable"}');
          return;
        }
        const jid = `dashboard:${folder}`;
        const existing = wdb.prepare('SELECT jid FROM registered_groups WHERE jid = ? OR folder = ?').get(jid, folder);
        if (existing) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end('{"error":"coworker already exists with this folder or JID"}');
          return;
        }

        // Resolve coworkerType: single type, or composite from multiple
        const selectedTypes: string[] = types || (type ? [type] : []);
        let coworkerType: string | null = null;
        if (selectedTypes.length === 1) {
          coworkerType = selectedTypes[0];
        } else if (selectedTypes.length > 1) {
          // Create composite entry in coworker-types.json
          const allTypes = getCoworkerTypes();
          const compositeKey = selectedTypes.join('+');
          if (!allTypes[compositeKey]) {
            const templates: string[] = [];
            const focusFiles: string[] = [];
            const descriptions: string[] = [];
            const mcpToolsSet = new Set<string>();
            for (const t of selectedTypes) {
              const entry = allTypes[t];
              if (entry) {
                const tpls = Array.isArray(entry.template) ? entry.template : [entry.template];
                templates.push(...tpls);
                if (entry.focusFiles) focusFiles.push(...entry.focusFiles);
                if (entry.allowedMcpTools) entry.allowedMcpTools.forEach((tool: string) => mcpToolsSet.add(tool));
                descriptions.push(entry.description || t);
              }
            }
            allTypes[compositeKey] = {
              description: descriptions.join(' + '),
              template: templates,
              base: 'slang-build',
              focusFiles,
              allowedMcpTools: [...mcpToolsSet],
            };
            writeFileSync(COWORKER_TYPES_PATH, JSON.stringify(allTypes, null, 2) + '\n');
            cachedTypes = null; // invalidate cache
          }
          coworkerType = compositeKey;
        }

        const groupDir = join(GROUPS_DIR, folder);
        mkdirSync(groupDir, { recursive: true });
        const triggerPattern = trigger || `@${name.replace(/\s+/g, '')}`;
        const now = new Date().toISOString();
        // Resolve MCP tools from coworker type
        const allTypesNow = getCoworkerTypes();
        const resolvedMcpTools = coworkerType && allTypesNow[coworkerType]?.allowedMcpTools
          ? JSON.stringify(allTypesNow[coworkerType].allowedMcpTools)
          : null;
        wdb.prepare(
          'INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger, is_main, coworker_type, allowed_mcp_tools) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)',
        ).run(jid, name, folder, triggerPattern, now, coworkerType, resolvedMcpTools);
        // Seed CLAUDE.md from global template (container-runner re-composes from coworkerType at startup)
        const globalMd = join(GROUPS_DIR, 'global', 'CLAUDE.md');
        const cwMd = join(groupDir, 'CLAUDE.md');
        if (existsSync(globalMd) && !existsSync(cwMd)) {
          copyFileSync(globalMd, cwMd);
        }
        // Also register in chats table
        wdb.prepare(
          'INSERT OR IGNORE INTO chats (jid, name, channel, is_group) VALUES (?, ?, ?, 0)',
        ).run(jid, name, 'dashboard');
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, jid, folder, name, trigger: triggerPattern }));
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: update coworker
  if (req.method === 'PUT' && /^\/api\/coworkers\/[^/]+$/.test(url.pathname)) {
    if (!requireAuth(req, res)) return;
    const folder = safeDecode(url.pathname.replace('/api/coworkers/', ''));
    if (!folder) { res.writeHead(400); res.end('{"error":"invalid folder"}'); return; }
    let body = '';
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      try {
        const updates = JSON.parse(body);
        const wdb = getWriteDb();
        if (!wdb) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end('{"error":"db unavailable"}');
          return;
        }
        const existing = wdb.prepare('SELECT * FROM registered_groups WHERE folder = ?').get(folder) as any;
        if (!existing) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end('{"error":"coworker not found"}');
          return;
        }
        if (updates.name) {
          wdb.prepare('UPDATE registered_groups SET name = ? WHERE folder = ?').run(updates.name, folder);
        }
        if (updates.trigger_pattern) {
          wdb.prepare('UPDATE registered_groups SET trigger_pattern = ? WHERE folder = ?').run(updates.trigger_pattern, folder);
        }
        if (updates.container_config !== undefined) {
          wdb.prepare('UPDATE registered_groups SET container_config = ? WHERE folder = ?').run(
            updates.container_config ? JSON.stringify(updates.container_config) : null, folder,
          );
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: get container name for shell exec
  if (req.method === 'GET' && /^\/api\/coworkers\/[^/]+\/container$/.test(url.pathname)) {
    const folder = safeDecode(url.pathname.replace('/api/coworkers/', '').replace('/container', ''));
    if (!folder) { res.writeHead(400); res.end('{"error":"invalid folder"}'); return; }
    const found = findRunningContainer(folder);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ running: !!found, container: found, execCommand: found ? `docker exec -it ${found} bash` : null }));
    return;
  }

  // API: execute command in container
  if (req.method === 'POST' && /^\/api\/coworkers\/[^/]+\/exec$/.test(url.pathname)) {
    if (!requireAuth(req, res)) return;
    const folder = safeDecode(url.pathname.replace('/api/coworkers/', '').replace('/exec', ''));
    if (!folder) { res.writeHead(400); res.end('{"error":"invalid folder"}'); return; }
    let body = '';
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      try {
        const { command } = JSON.parse(body);
        if (!command || typeof command !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"error":"command required"}');
          return;
        }
        // Find running container
        const found = findRunningContainer(folder);
        if (!found) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end('{"error":"no running container"}');
          return;
        }
        // Execute command (timeout 10s, max 64KB output)
        exec(`docker exec ${found} bash -c ${JSON.stringify(command)}`, { timeout: 10000, maxBuffer: 65536 }, (err, stdout, stderr) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            exitCode: err?.code || 0,
            stdout: stdout?.slice(0, 32768) || '',
            stderr: stderr?.slice(0, 8192) || '',
          }));
        });
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: delete coworker
  if (req.method === 'DELETE' && /^\/api\/coworkers\/[^/]+$/.test(url.pathname)) {
    if (!requireAuth(req, res)) return;
    const folder = safeDecode(url.pathname.replace('/api/coworkers/', ''));
    if (!folder) { res.writeHead(400); res.end('{"error":"invalid folder"}'); return; }
    const wdb = getWriteDb();
    if (!wdb) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"db unavailable"}');
      return;
    }
    const existing = wdb.prepare('SELECT * FROM registered_groups WHERE folder = ?').get(folder) as any;
    if (!existing) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"coworker not found"}');
      return;
    }
    // Don't allow deleting the main group
    if (existing.is_main) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end('{"error":"cannot delete the main group"}');
      return;
    }
    const jid = existing.jid;
    const deleteData = url.searchParams.has('deleteData');
    // Always unregister + clean DB rows (prevents orphaned entries in UI)
    // Order matters: delete children before parents (FK constraints)
    wdb.prepare('DELETE FROM messages WHERE chat_jid = ?').run(jid);
    wdb.prepare('DELETE FROM scheduled_tasks WHERE group_folder = ?').run(folder);
    wdb.prepare('DELETE FROM sessions WHERE group_folder = ?').run(folder);
    wdb.prepare('DELETE FROM chats WHERE jid = ?').run(jid);
    wdb.prepare('DELETE FROM registered_groups WHERE folder = ?').run(folder);
    // Always clean session files (prevents stale session ID errors on re-creation)
    const sessionDir = join(PROJECT_ROOT, 'data', 'sessions', folder);
    try { rmSync(sessionDir, { recursive: true, force: true }); } catch { /* ok */ }
    // Only delete group folder/artifacts when explicitly requested
    if (deleteData) {
      const groupDir = join(GROUPS_DIR, folder);
      try {
        rmSync(groupDir, { recursive: true, force: true });
      } catch { /* best-effort cleanup */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, dataDeleted: deleteData }));
    return;
  }

  // API: debug info
  // API: list files in a coworker's group folder (artifacts)
  if (req.method === 'GET' && /^\/api\/coworkers\/[^/]+\/files$/.test(url.pathname)) {
    const folder = safeDecode(url.pathname.replace('/api/coworkers/', '').replace('/files', ''));
    if (!folder) { res.writeHead(400); res.end('{"error":"invalid folder"}'); return; }
    const groupDir = join(GROUPS_DIR, folder);
    if (!isInsideDir(GROUPS_DIR, groupDir) && groupDir !== GROUPS_DIR) {
      res.writeHead(403); res.end('{"error":"forbidden"}'); return;
    }
    try {
      const files: { name: string; size: number; modified: string; isDir: boolean }[] = [];
      const entries = readdirSync(groupDir);
      for (const name of entries) {
        if (name.startsWith('.')) continue;
        try {
          const st = statSync(join(groupDir, name));
          files.push({
            name,
            size: st.size,
            modified: st.mtime.toISOString(),
            isDir: st.isDirectory(),
          });
        } catch { /* skip unreadable */ }
      }
      files.sort((a, b) => a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(files));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('[]');
    }
    return;
  }

  // API: download a file from coworker's group folder
  if (req.method === 'GET' && /^\/api\/coworkers\/[^/]+\/download\//.test(url.pathname)) {
    const parts = url.pathname.replace('/api/coworkers/', '').split('/download/');
    const folder = safeDecode(parts[0]);
    const filePath = safeDecode(parts.slice(1).join('/download/'));
    if (!folder || !filePath) { res.writeHead(400); res.end('bad request'); return; }
    const fullPath = join(GROUPS_DIR, folder, filePath);
    // Security: must be inside the group dir
    if (!isInsideDir(join(GROUPS_DIR, folder), fullPath)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    if (!existsSync(fullPath) || statSync(fullPath).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    const content = readFileSync(fullPath);
    const ext = filePath.split('.').pop() || '';
    const mimeTypes: Record<string, string> = { md: 'text/markdown', txt: 'text/plain', json: 'application/json', slang: 'text/plain', cpp: 'text/plain', h: 'text/plain', py: 'text/plain' };
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filePath.split('/').pop()}"`,
    });
    res.end(content);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/debug') {
    const mem = process.memoryUsage();
    const result: any = {
      pid: process.pid,
      uptime: process.uptime(),
      memory: {
        rss: mem.rss,
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        external: mem.external,
      },
      dbPath: DB_PATH,
      dbAvailable: !!db,
      rowCounts: {} as Record<string, number>,
      wsClients: wsClients.size,
      hookEventsBuffered: hookEvents.length,
    };
    if (db) {
      try {
        for (const table of ['messages', 'scheduled_tasks', 'task_run_logs', 'sessions', 'registered_groups', 'chats']) {
          result.rowCounts[table] = (db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as any)?.c || 0;
        }
      } catch { /* ignore */ }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // API: write CLAUDE.md for a group (admin panel)
  if (req.method === 'PUT' && url.pathname.startsWith('/api/memory/')) {
    if (!requireAuth(req, res)) return;
    const folder = safeDecode(url.pathname.replace('/api/memory/', ''));
    if (folder === null) { res.writeHead(400); res.end('bad request'); return; }
    const mdPath = resolve(GROUPS_DIR, folder, 'CLAUDE.md');
    if (!isInsideDir(GROUPS_DIR, mdPath)) {
      res.writeHead(403);
      res.end('{"error":"forbidden"}');
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        writeFileSync(mdPath, body, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: delete a task
  if (req.method === 'DELETE' && /^\/api\/tasks\/(\d+)$/.test(url.pathname)) {
    if (!requireAuth(req, res)) return;
    const id = url.pathname.match(/\/api\/tasks\/(\d+)/)![1];
    const wdb = getWriteDb();
    if (wdb) {
      try {
        wdb.prepare('DELETE FROM task_run_logs WHERE task_id=?').run(id);
        wdb.prepare('DELETE FROM scheduled_tasks WHERE id=?').run(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"db unavailable"}');
    }
    return;
  }

  // API: get config values
  if (req.method === 'GET' && url.pathname === '/api/config') {
    const configKeys = [
      { key: 'ASSISTANT_NAME', env: 'ASSISTANT_NAME', description: 'Name of the assistant' },
      { key: 'CONTAINER_IMAGE', env: 'CONTAINER_IMAGE', description: 'Docker image for agent containers' },
      { key: 'CONTAINER_TIMEOUT', env: 'CONTAINER_TIMEOUT', description: 'Max container run time (ms)' },
      { key: 'MAX_CONCURRENT_CONTAINERS', env: 'MAX_CONCURRENT_CONTAINERS', description: 'Max parallel containers' },
      { key: 'IDLE_TIMEOUT', env: 'IDLE_TIMEOUT', description: 'Idle shutdown timeout (ms)' },
      { key: 'TIMEZONE', env: 'TZ', description: 'System timezone' },
      { key: 'DASHBOARD_PORT', env: 'DASHBOARD_PORT', description: 'Dashboard server port' },
      { key: 'ANTHROPIC_MODEL', env: 'ANTHROPIC_MODEL', description: 'Claude model identifier' },
      { key: 'LOG_LEVEL', env: 'LOG_LEVEL', description: 'Logging verbosity' },
    ];
    const result = configKeys.map((c) => ({
      ...c,
      value: process.env[c.env] || '',
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // API: read/write root CLAUDE.md
  if (url.pathname === '/api/config/claude-md') {
    const mdPath = join(PROJECT_ROOT, 'CLAUDE.md');
    if (req.method === 'GET') {
      try {
        const content = readFileSync(mdPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
      return;
    }
    if (req.method === 'PUT') {
      if (!requireAuth(req, res)) return;
      let body = '';
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        try {
          writeFileSync(mdPath, body, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch (e: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
  }

  // API: list channels
  if (req.method === 'GET' && url.pathname === '/api/channels') {
    const channels: any[] = [];
    try {
      if (existsSync(CHANNELS_DIR)) {
        const exclude = new Set(['index.ts', 'registry.ts', 'registry.test.ts']);
        for (const file of readdirSync(CHANNELS_DIR)) {
          if (!file.endsWith('.ts') || exclude.has(file) || file.includes('.test.')) continue;
          const name = file.replace('.ts', '');
          // Determine prefix for JID matching
          const prefixMap: Record<string, string> = { telegram: 'tg:', whatsapp: 'wa:', discord: 'disc:', slack: 'slack:' };
          const prefix = prefixMap[name] || `${name}:`;
          const groups: any[] = [];
          if (db) {
            try {
              const rows = db.prepare('SELECT name, folder, jid FROM registered_groups WHERE jid LIKE ?').all(`${prefix}%`) as any[];
              for (const r of rows) groups.push({ name: r.name, folder: r.folder });
            } catch { /* ignore */ }
          }
          channels.push({ name, type: name, configured: groups.length > 0, groups });
        }
      }
    } catch { /* ignore */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(channels));
    return;
  }

  // API: get logs
  if (req.method === 'GET' && url.pathname === '/api/logs') {
    const source = url.searchParams.get('source') || 'app';
    const group = url.searchParams.get('group') || '';
    const search = url.searchParams.get('search') || '';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '500', 10), 2000);

    let logFile = '';
    if (source === 'app') {
      logFile = join(LOGS_DIR, 'nanoclaw.log');
    } else if (source === 'error') {
      logFile = join(LOGS_DIR, 'nanoclaw.error.log');
    } else if (source === 'container' && group) {
      // Find most recent container log for this group
      const groupLogDir = join(GROUPS_DIR, group, 'logs');
      if (existsSync(groupLogDir)) {
        const logFiles = readdirSync(groupLogDir)
          .filter((f) => f.startsWith('container-') && f.endsWith('.log'))
          .sort()
          .reverse();
        if (logFiles.length > 0) logFile = join(groupLogDir, logFiles[0]);
      }
    }

    if (!logFile || !existsSync(logFile)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ lines: [], file: logFile || 'none' }));
      return;
    }

    try {
      let content = readFileSync(logFile, 'utf-8');
      // Strip ANSI codes
      content = content.replace(/\x1b\[[0-9;]*m/g, '');
      let lines = content.split('\n').filter((l) => l.trim());
      if (search) {
        const lowerSearch = search.toLowerCase();
        lines = lines.filter((l) => l.toLowerCase().includes(lowerSearch));
      }
      // Return last N lines
      lines = lines.slice(-limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ lines, file: logFile }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ lines: [], file: logFile }));
    }
    return;
  }

  // API: get single skill content
  if (req.method === 'GET' && /^\/api\/skills\/[^/]+$/.test(url.pathname) && url.pathname !== '/api/skills') {
    const name = safeDecode(url.pathname.replace('/api/skills/', ''));
    if (name === null) { res.writeHead(400); res.end('bad request'); return; }
    const skillDir = resolve(SKILLS_DIR, name);
    if (!isInsideDir(SKILLS_DIR, skillDir)) {
      res.writeHead(403);
      res.end('{"error":"forbidden"}');
      return;
    }
    const skillMd = join(skillDir, 'SKILL.md');
    try {
      const content = readFileSync(skillMd, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
    return;
  }

  // API: create skill
  if (req.method === 'POST' && url.pathname === '/api/skills' && req.headers['content-type']?.includes('application/json')) {
    if (!requireAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      try {
        const { name, content } = JSON.parse(body);
        if (!name || !/^[a-z0-9-]+$/.test(name)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"error":"Invalid skill name (use lowercase alphanumeric and hyphens)"}');
          return;
        }
        const skillDir = resolve(SKILLS_DIR, name);
        if (!isInsideDir(SKILLS_DIR, skillDir)) {
          res.writeHead(403);
          res.end('{"error":"forbidden"}');
          return;
        }
        if (existsSync(skillDir)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end('{"error":"Skill already exists"}');
          return;
        }
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(join(skillDir, 'SKILL.md'), content || `# ${name}\n\nNew skill.\n`, 'utf-8');
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name }));
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: update skill
  if (req.method === 'PUT' && /^\/api\/skills\/[^/]+$/.test(url.pathname)) {
    if (!requireAuth(req, res)) return;
    const name = safeDecode(url.pathname.replace('/api/skills/', ''));
    if (name === null) { res.writeHead(400); res.end('bad request'); return; }
    const skillDir = resolve(SKILLS_DIR, name);
    if (!isInsideDir(SKILLS_DIR, skillDir)) {
      res.writeHead(403);
      res.end('{"error":"forbidden"}');
      return;
    }
    let body = '';
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      try {
        writeFileSync(join(skillDir, 'SKILL.md'), body, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // API: delete skill
  if (req.method === 'DELETE' && /^\/api\/skills\/[^/]+$/.test(url.pathname)) {
    if (!requireAuth(req, res)) return;
    const name = safeDecode(url.pathname.replace('/api/skills/', ''));
    if (name === null) { res.writeHead(400); res.end('bad request'); return; }
    if (url.searchParams.get('confirm') !== 'true') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"error":"Add ?confirm=true to delete"}');
      return;
    }
    const skillDir = resolve(SKILLS_DIR, name);
    if (!isInsideDir(SKILLS_DIR, skillDir)) {
      res.writeHead(403);
      res.end('{"error":"forbidden"}');
      return;
    }
    try {
      rmSync(skillDir, { recursive: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: send chat message
  if (req.method === 'POST' && url.pathname === '/api/chat/send') {
    if (!requireAuth(req, res)) return;
    let body = '';
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => {
      try {
        const { group, content } = JSON.parse(body);
        if (!group || !content) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end('{"error":"group and content required"}');
          return;
        }
        // Look up JID from registered_groups
        if (!db) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end('{"error":"db unavailable"}');
          return;
        }
        const row = db.prepare('SELECT jid FROM registered_groups WHERE folder = ?').get(group) as any;
        if (!row) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end('{"error":"group not found"}');
          return;
        }
        const wdb = getWriteDb();
        if (!wdb) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end('{"error":"db unavailable for write"}');
          return;
        }
        const timestamp = new Date().toISOString();
        const msgId = `dash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        // Ensure chats row exists (FK: messages.chat_jid → chats.jid)
        wdb.prepare(
          `INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, 'dashboard', 1)
           ON CONFLICT(jid) DO UPDATE SET last_message_time = MAX(last_message_time, excluded.last_message_time)`,
        ).run(row.jid, group, timestamp);
        wdb.prepare(
          'INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, 0, 0)',
        ).run(msgId, row.jid, 'web@dashboard', 'Dashboard', content, timestamp);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, timestamp }));
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Static files
  const decodedPath = safeDecode(url.pathname);
  if (decodedPath === null) { res.writeHead(400); res.end('bad request'); return; }
  let filePath = decodedPath === '/' ? '/index.html' : decodedPath;
  filePath = resolve(PUBLIC_DIR, '.' + filePath);
  if (!isInsideDir(PUBLIC_DIR, filePath)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }

  try {
    const content = readFileSync(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

/** Start the dashboard server (binds port, sets up WebSocket, timers). */
export function startServer(port = PORT, host = DASHBOARD_HOST): import('http').Server {
  const server = createServer(handleRequest);

  server.on('upgrade', (req, socket, head) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    const acceptKey = computeAcceptKey(key);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n` +
        '\r\n',
    );

    wsClients.add(socket);

    const state = JSON.stringify({ type: 'state', data: getState() });
    socket.write(createWsFrame(Buffer.from(state)));

    let buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      while (true) {
        const frame = parseWsFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.consumed);
        if (frame.opcode === 0x8) {
          // Close: reply with close and terminate socket.
          try {
            socket.write(createWsFrame(frame.payload, 0x8));
          } finally {
            socket.end();
          }
          return;
        }
        if (frame.opcode === 0x9) {
          // Ping: keep browser connections alive by replying with pong.
          socket.write(createWsFrame(frame.payload, 0xA));
          continue;
        }
      }
    });

    socket.on('close', () => wsClients.delete(socket));
    socket.on('error', () => wsClients.delete(socket));
  });

  // Poll and broadcast state every 500ms
  const broadcastTimer = setInterval(() => {
    if (!db) db = openDb();
    broadcastState();
  }, 500);
  broadcastTimer.unref?.();

  // Expire stale hook state (>30s old)
  const expireTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, val] of liveHookState) {
      if (now - val.ts > 30000) liveHookState.delete(key);
    }
    for (const [group, subagents] of liveSubagentState) {
      for (const [agentId, subagent] of subagents) {
        const isExpiredLeaving = subagent.phase === 'leaving' && subagent.exitAt !== null && now > subagent.exitAt;
        const isExpiredActive = subagent.phase !== 'leaving' && now - subagent.lastActivity > SUBAGENT_STALE_MS;
        if (isExpiredLeaving || isExpiredActive) subagents.delete(agentId);
      }
      if (subagents.size === 0) liveSubagentState.delete(group);
    }
  }, 5000);
  expireTimer.unref?.();

  // Retention cleanup: delete hook_events older than HOOK_RETENTION_DAYS (default 7)
  const retentionDays = parseInt(process.env.HOOK_RETENTION_DAYS || '7', 10);
  const retentionTimer = setInterval(() => {
    const heDb = getHookEventsDb();
    if (heDb) {
      try {
        const cutoff = Date.now() - retentionDays * 86400000;
        heDb.prepare('DELETE FROM hook_events WHERE timestamp < ?').run(cutoff);
      } catch { /* non-fatal */ }
    }
  }, 3600000); // every hour
  retentionTimer.unref?.();

  server.on('close', () => {
    clearInterval(broadcastTimer);
    clearInterval(expireTimer);
    clearInterval(retentionTimer);
    for (const client of sseClients) {
      try {
        client.end();
      } catch {
        /* ignore */
      }
    }
    sseClients.clear();
  });

  server.listen(port, host, () => {
    console.log(`\n  Slang Dashboard`);
    console.log(`  http://${host}:${port}\n`);
    console.log(`  Tab 1: Pixel Art Office (real-time)`);
    console.log(`  Tab 2: Timeline (all-time metrics)`);
    if (process.env.DASHBOARD_SECRET) console.log(`  Auth: Bearer token required for admin mutations`);
    console.log();
  });

  return server;
}

// Auto-start when run directly (not imported by tests)
if (!process.env.VITEST) {
  startServer();
}
