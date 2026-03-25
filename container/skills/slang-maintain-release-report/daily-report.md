# Daily Report

Aggregates activity from GitHub, GitLab, Discord, and Slack into a structured summary.

## Data Sources

### GitHub (shader-slang/slang)
```
mcp__slang-mcp__github_list_pull_requests — merged PRs in time range
mcp__slang-mcp__github_list_issues — new/closed issues
mcp__slang-mcp__github_get_discussions — active discussions
```

### GitLab (if configured)
```
mcp__slang-mcp__gitlab_list_merge_requests — nv-master MRs
mcp__slang-mcp__gitlab_list_issues — internal issues
```

### Discord
```
mcp__slang-mcp__discord_read_messages — fetch with limit, filter client-side to time range
```

Channel IDs:
| Channel ID | Name |
|------------|------|
| `1303735244108595330` | slang-dev |
| `1305995870046650368` | slang-discussion |
| `1313936640661524601` | slang-support |
| `1303743245133545502` | off-topic |
| `1451325535635505183` | slangpy-discussion |
| `1337094433816051813` | slangpy-support |

Note: `1352357976878481468` returns 403 (missing access).

### Slack
```
mcp__slang-mcp__slack_get_channel_history — recent messages
```

Channel IDs:
| Channel ID | Name |
|------------|------|
| `CFFF96M6Z` | Main Slang channel |

## Report Format

```
*Slang Daily Report — {date}*

*GitHub*
• {n} PRs merged: {titles with PR numbers}
• {n} issues opened: {titles}
• {n} issues closed: {titles}
• Active discussions: {titles}

*Community (Discord/Slack)*
• Key questions: {summary}
• Bug reports: {summary}
• Unanswered threads: {count}

*GitLab (nv-master)*
• {n} MRs merged
• Sync status: {ahead/behind master}
```

## Workflow

1. Determine time range (default: last 24h)
2. Fetch GitHub PRs, issues, discussions via MCP tools
3. Fetch Discord/Slack messages via MCP tools
4. Fetch GitLab MRs if configured
5. Categorize and deduplicate
6. Generate formatted report
7. Send via `mcp__nanoclaw__send_message` or write to file
