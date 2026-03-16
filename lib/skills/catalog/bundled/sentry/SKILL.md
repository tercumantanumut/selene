---
name: "sentry"
description: "Use when the user asks to inspect Sentry issues or events, summarize recent production errors, or pull basic Sentry health data via the Sentry API; perform read-only queries with the bundled script and require `SENTRY_AUTH_TOKEN`."
---


# Sentry (Read-only Observability)

## Quick start

- If not already authenticated, ask the user to provide a valid `SENTRY_AUTH_TOKEN` (read-only scopes such as `project:read`, `event:read`) or to log in and create one before running commands.
- Set `SENTRY_AUTH_TOKEN` as an env var.
- Optional defaults: `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_BASE_URL`.
- Defaults: org/project `{your-org}`/`{your-project}`, time range `24h`, environment `prod`, limit 20 (max 50).
- Always call the Sentry API (no heuristics, no caching).

If the token is missing, give the user these steps:
1. Create a Sentry auth token: https://sentry.io/settings/account/api/auth-tokens/
2. Create a token with read-only scopes such as `project:read`, `event:read`, and `org:read`.
3. Set `SENTRY_AUTH_TOKEN` as an environment variable in their system.
4. Offer to guide them through setting the environment variable for their OS/shell if needed.
- Never ask the user to paste the full token in chat. Ask them to set it locally and confirm when ready.

## Core tasks (use bundled script)

Use `${SELENE_SKILL_ROOT}/scripts/sentry_api.py` for deterministic API calls. It handles pagination and retries once on transient errors.

## Skill path (set once)

```bash
export SENTRY_API="${SELENE_SKILL_ROOT}/scripts/sentry_api.py"
```


### 1) List issues (ordered by most recent)

```bash
python3 "$SENTRY_API" \
  list-issues \
  --org {your-org} \
  --project {your-project} \
  --environment prod \
  --time-range 24h \
  --limit 20 \
  --query "is:unresolved"
```

### 2) Resolve an issue short ID to issue ID

```bash
python3 "$SENTRY_API" \
  list-issues \
  --org {your-org} \
  --project {your-project} \
  --query "ABC-123" \
  --limit 1
```

Use the returned `id` for issue detail or events.

### 3) Issue detail

```bash
python3 "$SENTRY_API" \
  issue-detail \
  1234567890
```

### 4) Issue events

```bash
python3 "$SENTRY_API" \
  issue-events \
  1234567890 \
  --limit 20
```

### 5) Event detail (no stack traces by default)

```bash
python3 "$SENTRY_API" \
  event-detail \
  --org {your-org} \
  --project {your-project} \
  abcdef1234567890
```

## Validation

After resolving a short ID to an issue ID, verify the returned ID is non-empty before querying issue details or events.

## Output formatting rules

- Issue list: show title, short_id, status, first_seen, last_seen, count, environments, top_tags; order by most recent.
- Event detail: include culprit, timestamp, environment, release, url.
- If no results, state explicitly.
- Redact PII in output (emails, IPs). Do not print raw stack traces.
- Never echo auth tokens.

## Reference

<details>
<summary>API endpoints and defaults</summary>

Endpoints (GET only):
- List issues: `/api/0/projects/{org_slug}/{project_slug}/issues/`
- Issue detail: `/api/0/issues/{issue_id}/`
- Events for issue: `/api/0/issues/{issue_id}/events/`
- Event detail: `/api/0/projects/{org_slug}/{project_slug}/events/{event_id}/`

Defaults: `org_slug`/`project_slug` from env vars, `time_range` 24h, `environment` prod, `limit` 20 (max 50).
</details>
