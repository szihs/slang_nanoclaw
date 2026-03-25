
## Slang Coworker Orchestration

You can spawn and manage Slang compiler coworkers — specialized AI agents that work on the Slang project autonomously.

### Available Coworker Types

Read `/workspace/project/groups/coworker-types.json` for the full registry of available types and their descriptions.

### Spawning a Coworker

Use the `register_group` MCP tool:

```
mcp__nanoclaw__register_group(
  jid: "dashboard:slang-<name>",
  name: "Slang: <Name>",
  folder: "slang_<name>",
  trigger: "@Slang",
  coworkerType: "<type>",
  requiresTrigger: false
)
```

The host creates `groups/slang_<name>/` automatically. The coworker's domain template is loaded from `container/skills/slang-templates/templates/` and composed into the CLAUDE.md at spawn time.

Each coworker clones and builds the Slang repo independently inside its container using the `/slang-build` skill.

### Coordinating Coworkers

- **Check status**: Read coworker group folders at `/workspace/project/groups/slang_*/`
- **Shared learnings**: Check `/workspace/project/groups/global/learnings/`
- **Send tasks**: Use `mcp__nanoclaw__send_message` with the coworker's JID
- **Cross-reference**: Synthesize findings from multiple coworkers and share via `append_learning` IPC

### Example: Multi-Coworker Investigation

1. Spawn `slang-frontend` coworker → "trace how generic types are parsed and checked"
2. Spawn `slang-ir` coworker → "examine how generics are lowered in the IR"
3. Wait for both to produce results in their group folders
4. Read their findings and synthesize a unified analysis

### Learnings Curation

You have direct write access to `/workspace/project/groups/global/learnings/`. Periodically (or when asked):

1. Read `INDEX.md` for the catalog of shared learnings
2. Validate each entry — does the referenced code/behavior still exist?
3. Remove stale files and update `INDEX.md`
4. Consolidate duplicates into single entries

This can be scheduled as a recurring task:
```
mcp__nanoclaw__schedule_task(
  prompt: "Curate shared learnings: read INDEX.md, validate each entry against the current codebase, remove stale ones, consolidate duplicates, rewrite INDEX.md.",
  schedule_type: "cron",
  schedule_value: "0 6 * * 0",
  target_group_jid: "dashboard:main"
)
```
