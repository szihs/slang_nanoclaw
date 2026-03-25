---
name: dashboard
description: Pixel office dashboard for NanoClaw. Real-time visualization of coworker agents, hook event timeline, and observability. Use for setup, troubleshooting, or extending the dashboard. Triggers on "dashboard", "pixel office", "observability", "agent dashboard".
---

# NanoClaw Dashboard

Two-tab real-time dashboard:
- **Tab 1 — Pixel Office**: Interactive isometric pixel art office. Each agent is a character. Click to see status, memory, hook log, subagents.
- **Tab 2 — Timeline**: Chronological event stream with stats, sparklines, session flow drilldown.

```
┌─────────────────────────────────────────────────────┐
│  Container (agent)                                   │
│  └── Hook callbacks POST to dashboard               │
└──────────────────┬──────────────────────────────────┘
                   │ HTTP POST /api/hook-event
                   ▼
┌─────────────────────────────────────────────────────┐
│  Dashboard Server (dashboard/server.ts)              │
│  ├── REST API (/api/state, /api/messages, etc.)     │
│  ├── SSE stream (/api/events)                        │
│  └── Static files (pixel art office UI)              │
└─────────────────────────────────────────────────────┘
```

## File Structure

```
.claude/skills/dashboard/
├── SKILL.md                  # This file
├── dashboard-channel.ts      # Virtual channel (copy to src/channels/dashboard.ts)
├── integration.md            # Patches for host code integration
└── gotchas.md                # Known issues and fixes

dashboard/                    # The dashboard itself (copied by setup)
├── server.ts                 # HTTP server (1950 lines)
├── server.test.ts            # Tests (354 lines)
└── public/
    ├── index.html            # UI (two tabs: pixel office + timeline)
    ├── app.js                # Frontend logic (SSE, state, rendering)
    ├── sprites.js            # Pixel art sprite engine
    └── assets/               # Characters, furniture, floors, walls
```

## Setup

### Step 1: Copy dashboard code

The `dashboard/` directory should already exist at your project root after merging the skill branch. If applying manually:

```bash
# Dashboard code is in this skill's parent repo
cp -r dashboard/ /path/to/your/nanoclaw/dashboard/
```

### Step 2: Register the virtual channel

Copy the dashboard channel to your channels directory:

```bash
cp .claude/skills/dashboard/dashboard-channel.ts src/channels/dashboard.ts
```

Then add the import to `src/channels/index.ts`. Read `integration.md` for the exact patch.

### Step 3: Apply host integration patches

Read `integration.md` for patches to:
- `src/channels/index.ts` — register dashboard channel
- `src/container-runner.ts` — configure HTTP hooks to POST events to dashboard
- `container/agent-runner/src/index.ts` — add dashboard hook callbacks
- `package.json` — add `dashboard` script
- `vitest.config.ts` — include dashboard tests

### Step 4: Build and start

```bash
npm run build
npm run dashboard        # Starts on port 3737
# Open http://localhost:3737
```

### Step 5: Verify

1. Dashboard loads at `http://localhost:3737`
2. Pixel office shows with default layout
3. When an agent runs, events appear in the timeline
4. Click a character to see its detail panel

## Quick Reference

| Endpoint | Purpose |
|----------|---------|
| `GET /` | Dashboard UI |
| `GET /api/state` | Current agent states |
| `GET /api/messages?jid=X&limit=N` | Message history |
| `POST /api/hook-event` | Receive hook events from agents |
| `GET /api/events` | SSE stream for real-time updates |
| `GET /api/groups` | Registered groups |
| `GET /api/skills` | Available container skills |
| `GET /api/coworker-types` | Coworker type registry |
| `GET /api/layout` | Office layout (positions, furniture) |
| `PUT /api/layout` | Save custom layout |
