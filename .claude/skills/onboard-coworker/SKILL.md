---
name: onboard-coworker
description: Create a new AI coworker role for NanoClaw. Interactive wizard that builds skills, tools, CLAUDE.md templates, and container config for a new coworker type (e.g., software quality coworker, security auditor, documentation writer). Use when user wants to add a new coworker role or customize an existing one.
triggers:
  - onboard.?coworker
  - create.?coworker
  - new.?coworker
  - add.?coworker
  - coworker.?role
---

# Onboard Coworker

This skill creates new AI coworker instances for NanoClaw. It determines the best registration strategy based on what already exists.

## Critical Constraints — READ FIRST

**You are running inside a container with these limitations:**

1. **`/workspace/project/` is READ-ONLY.** You CANNOT write to:
   - `groups/coworker-types.json`
   - `container/skills/slang-templates/templates/*.md`
   - Any file under the project root

2. **Session skill files get wiped.** Files written to `/home/node/.claude/skills/` are overwritten on every container startup by the host's skill sync. Do NOT write templates here expecting them to persist.

3. **IPC only supports specific commands.** There is no `write_file` IPC handler. The supported task types are: `schedule_task`, `pause_task`, `resume_task`, `cancel_task`, `update_task`, `refresh_groups`, `register_group`, `append_learning`.

4. **`coworkerType` and `claudeMdAppend` conflict.** When `register_group` is called with BOTH `coworkerType` set AND `claudeMdAppend`, the `claudeMdAppend` content is written once but then OVERWRITTEN on the next container startup by the CLAUDE.md composition system (which rebuilds from templates). **Never set both.**

## Key Files (READ-ONLY reference)

| File | Purpose |
|------|---------|
| `groups/coworker-types.json` | Registry of all typed coworker roles (read to check what exists) |
| `groups/global/CLAUDE.md` | Base persona template (auto-seeded to new groups) |
| `container/skills/slang-templates/templates/*.md` | Domain-specific role templates (read for reference) |
| `container/skills/*/SKILL.md` | Container skills available to all coworkers |

## Phase 0: Discovery — Show What Exists

Before asking the user anything:

1. Read `groups/coworker-types.json` and list all existing coworker types with descriptions
2. Scan `groups/` for spawned instances and show active instances per type
3. List available container skills from `container/skills/`

Present as a formatted summary, then ask using AskUserQuestion:
- **"Spawn existing type"** — register a new instance of an existing typed coworker
- **"Create custom coworker"** — build a new specialized coworker with custom instructions

## Phase 1: Evaluate — Does an Existing Type Fit?

Read `groups/coworker-types.json` and the templates it references. Compare the user's requirements against what exists:

- What domain/project does the coworker need?
- What tools/MCP access does it need?
- What skills does it need?
- Are there any RESTRICTIONS (tool limits, access controls)?

### Decision: Typed vs Static

**Use existing `coworkerType`** when:
- The user wants a standard specialist (e.g., another IR investigator, another frontend debugger)
- No custom tool restrictions or unique workflow requirements
- The existing template covers the role adequately

→ Register with `coworkerType: "<existing-type>"` and optional `claudeMdAppend: null`

**Use `coworkerType: null` with `claudeMdAppend`** when:
- The role needs custom MCP tool restrictions (e.g., "only these 2 tools")
- The role has a unique workflow not covered by existing templates
- The role combines capabilities from multiple types
- The role needs instructions that don't fit any existing template

→ Register with `coworkerType: null` and full `claudeMdAppend` containing all specialization

## Phase 1.5: MCP Tool Selection

Ask the user what external access this coworker needs. Default for custom coworkers is **none** (only `mcp__nanoclaw__*` for IPC, which is always included automatically).

Available MCP tools (grouped by server):

**DeepWiki** (codebase Q&A):
- `mcp__deepwiki__ask_question` — Ask questions about any public repo

**Slang-MCP / GitHub** (read-only):
- `mcp__slang-mcp__github_get_issue` — Read a specific issue
- `mcp__slang-mcp__github_get_pull_request` — Read a specific PR
- `mcp__slang-mcp__github_get_pull_request_comments` — Read PR comments
- `mcp__slang-mcp__github_get_pull_request_reviews` — Read PR reviews
- `mcp__slang-mcp__github_list_issues` — List/search issues
- `mcp__slang-mcp__github_search_issues` — Search issues
- `mcp__slang-mcp__github_list_pull_requests` — List PRs
- `mcp__slang-mcp__github_get_discussions` — Read discussions

**Slang-MCP / GitLab** (read-only):
- `mcp__slang-mcp__gitlab_get_file_contents` — Read file from GitLab
- `mcp__slang-mcp__gitlab_list_issues` — List GitLab issues
- `mcp__slang-mcp__gitlab_list_merge_requests` — List merge requests

**Slang-MCP / Discord**:
- `mcp__slang-mcp__discord_read_messages` — Read Discord messages

**Slang-MCP / Slack**:
- `mcp__slang-mcp__slack_get_channel_history` — Read channel history
- `mcp__slang-mcp__slack_search_messages` — Search messages
- `mcp__slang-mcp__slack_get_user_profile` — Get user profile
- `mcp__slang-mcp__slack_post_message` — Post to channel (write)
- `mcp__slang-mcp__slack_reply_to_thread` — Reply in thread (write)

Ask clarifying questions like:
- "Does this coworker need to read GitHub issues or PRs for context?"
- "Does it need to query documentation via DeepWiki?"
- "Does it need Discord/Slack access for communication?"

Build the `allowedMcpTools` array from the user's answers. Only include exact tool names — no wildcards.

## Phase 2: Build the Coworker Instructions

### Path A: Existing Type

Simply register with `coworkerType` set. The host will compose CLAUDE.md automatically from layers. MCP tools are inherited from `coworker-types.json` defaults for the type.

```json
{
  "type": "register_group",
  "jid": "dashboard:<name>",
  "name": "<display-name>",
  "folder": "slang_<name>",
  "trigger": "@<TriggerName>",
  "requiresTrigger": false,
  "coworkerType": "<existing-type>",
  "claudeMdAppend": null
}
```

### Path B: Custom Coworker (Static)

Build a comprehensive `claudeMdAppend` string. Read existing templates as reference for structure and quality:

```bash
# Read relevant templates for inspiration
cat /workspace/project/container/skills/slang-templates/templates/slang-testing.md
cat /workspace/project/container/skills/slang-templates/templates/slang-frontend.md
```

The `claudeMdAppend` should include ALL of the following sections as needed:

```markdown
# <Role Name>

<One paragraph describing the role and its purpose.>

## Allowed MCP Tools — STRICT RESTRICTION

You are **only permitted** to use these MCP tools:

| Tool | Purpose |
|------|---------|
| `mcp__tool__name` | Description |

Do NOT call any other MCP tools.

## Skills Available

- `/skill-name` — description
- `/skill-name` — description

## Workflow

<Step-by-step workflow the coworker should follow>

## Parallel Subagent Pattern (if applicable)

<Instructions for parallel execution>

## Key Files (if applicable)

| File | Purpose |
|------|---------|
| ... | ... |

## Team Pairing

- **<type>** — when to escalate
```

**Important:** The `claudeMdAppend` is appended AFTER the base `global/CLAUDE.md` which already provides the persona, workspace layout, communication style, learning patterns, and message formatting. Do NOT duplicate those. Focus only on the domain-specific specialization.

### Register with IPC

Write the registration as a JSON file to `/workspace/ipc/tasks/`:

```bash
cat > /workspace/ipc/tasks/register_$(date +%s).json << 'IPCEOF'
{
  "type": "register_group",
  "jid": "dashboard:<name>",
  "name": "<Display Name>",
  "folder": "dashboard_<name>",
  "trigger": "@<TriggerName>",
  "requiresTrigger": false,
  "coworkerType": null,
  "claudeMdAppend": "<full specialization content>",
  "allowedMcpTools": ["mcp__deepwiki__ask_question", "mcp__slang-mcp__github_get_issue"]
}
IPCEOF
```

Or use the MCP tool:
```
mcp__nanoclaw__register_group({
  jid: "dashboard:<name>",
  name: "<Display Name>",
  folder: "dashboard_<name>",
  trigger: "@<TriggerName>",
  requiresTrigger: false,
  coworkerType: null,
  claudeMdAppend: "<full specialization content>",
  allowedMcpTools: ["mcp__deepwiki__ask_question", "mcp__slang-mcp__github_get_issue"]
})
```

**Note:** `allowedMcpTools` controls hard enforcement at the SDK level. `mcp__nanoclaw__*` is always included automatically — do not add it to the list. If `allowedMcpTools` is omitted or empty, only `mcp__nanoclaw__*` will be available.

## Phase 3: Container Dependencies

Check if new tools are needed in the container:

```bash
grep 'apt-get install\|npm install -g\|pip install' /workspace/project/container/Dockerfile
```

If new tools are needed, inform the user that `container/Dockerfile` needs to be updated and the container rebuilt with `./container/build.sh`. You cannot do this from inside the container.

## Phase 4: Test and Verify

After registration, send a test message to the new coworker:

```bash
cat > /workspace/ipc/tasks/test_$(date +%s).json << 'EOF'
{
  "type": "message",
  "chatJid": "dashboard:<name>",
  "text": "Hello! Please confirm your role and what tools you have access to.",
  "sender": "coordinator"
}
EOF
```

## Phase 5: Summary

Report what was created:

```
=== New Coworker: <name> ===

Registration: coworkerType=<type or null>
Instructions: <"template-based (auto-updating)" or "static (frozen at creation)">
Trigger: @<TriggerName>
JID: dashboard:<name>
Folder: dashboard_<name>

<If static:>
Note: This coworker has frozen instructions. To update its CLAUDE.md,
edit groups/dashboard_<name>/CLAUDE.md directly on the host.

<If typed:>
Note: This coworker's CLAUDE.md is auto-composed from templates.
Update the template at <path> to change all coworkers of this type.
```

## Visual Indicator

- **Typed coworkers** (`coworkerType` set) show an "auto-update" indicator in the dashboard — their CLAUDE.md refreshes from templates on every container startup.
- **Static coworkers** (`coworkerType` null) show a "static" indicator — their CLAUDE.md is frozen at creation time unless manually edited.
