# Host Integration Patches

These patches integrate the dashboard with NanoClaw's host process. Apply each one.

---

## 1. Register dashboard channel

**File**: `src/channels/index.ts`

Add this import near the top of the barrel file:

```typescript
// dashboard (virtual channel for dashboard:* JIDs)
import './dashboard.js';
```

---

## 2. Add dashboard script to package.json

**File**: `package.json`

Add to the `"scripts"` section:

```json
"dashboard": "tsx dashboard/server.ts"
```

---

## 3. Include dashboard tests

**File**: `vitest.config.ts`

Update the `include` array:

```typescript
include: ['src/**/*.test.ts', 'setup/**/*.test.ts', 'dashboard/**/*.test.ts'],
```

---

## 4. Configure HTTP hooks in container-runner

**File**: `src/container-runner.ts`

This is the largest integration. The container-runner needs to:
1. Set `DASHBOARD_URL` env var for containers
2. Configure native HTTP hooks that POST events to the dashboard
3. Pass `NANOCLAW_GROUP_FOLDER` so the dashboard knows which group sent the event

Add to `buildVolumeMounts()` after the settings file setup:

```typescript
const dashboardPort = process.env.DASHBOARD_PORT || '3737';
const dashboardUrl = `http://${CONTAINER_HOST_GATEWAY}:${dashboardPort}`;

// Add to managedEnv:
const managedEnv: Record<string, string> = {
  // ... existing keys ...
  NANOCLAW_GROUP_FOLDER: group.folder,
  DASHBOARD_URL: dashboardUrl,
};
```

Configure HTTP hooks for each event type:

```typescript
const hookEvents = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'SessionStart', 'SessionEnd', 'Stop',
  'Notification', 'UserPromptSubmit', 'PermissionRequest',
  'SubagentStart', 'SubagentStop',
  'TaskCompleted', 'TeammateIdle',
  'PreCompact', 'PostCompact',
  'InstructionsLoaded',
];
const nanoclawHookUrl = `${dashboardUrl}/api/hook-event`;

for (const event of hookEvents) {
  mergedHooks[event] = [
    {
      hooks: [{
        type: 'http',
        url: nanoclawHookUrl,
        headers: { 'X-Group-Folder': '$NANOCLAW_GROUP_FOLDER' },
        allowedEnvVars: ['NANOCLAW_GROUP_FOLDER'],
        timeout: 5,
      }],
    },
    // ... preserve existing user hooks ...
  ];
}
```

Add to `buildContainerArgs()`:

```typescript
const dashboardPort = process.env.DASHBOARD_PORT || '3737';
args.push('-e', `NANOCLAW_GROUP_FOLDER=${groupFolder}`);
args.push('-e', `DASHBOARD_URL=http://${CONTAINER_HOST_GATEWAY}:${dashboardPort}`);
```

---

## 5. Dashboard hook delivery

Dashboard hooks are delivered via **native HTTP hooks in settings.json** (configured by `container-runner.ts` in section 4 above). No changes to `container/agent-runner/src/index.ts` are needed.

The agent-runner only has the `PreCompact` SDK callback for transcript archival. All other hook events (tool use, notifications, sessions, subagents) are sent to the dashboard by Claude Code's native HTTP hook system.
