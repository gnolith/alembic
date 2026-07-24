---
name: alembic
description: Inspect, plan, apply, resume, or diagnose the one project-scoped Gnolith Workshop connection.
---

# Alembic

Alembic is setup/diagnostics only, never a proxy or Gnolith data plane.
Ordinary Gnolith work uses Workshop directly after activation.

Start with `alembic_inspect` using the exact absolute current task directory.
If versioned trusted Codex metadata is unavailable, confirm the exact canonical
root before mutation. Never infer a parent, plugin directory, or repository.

If configured and live, stop using Alembic. If configured but unavailable or
wrong, diagnose and perform only an approved bounded repair/rebind. If absent,
discover and create one digest-bound plan. Never overwrite a user-owned
`[mcp_servers.gnolith]`.

Supported targets are Seedbed Docker-local and connect-existing remote
Workshop. Process/stdio and Codex Sites provisioning are unsupported. Pass
an explicitly approved external Seedbed state root for Docker-local; Seedbed
must attest that it is outside the project and every worktree. Pass
credential selectors only, never secret values, headers, commands, environment
maps, SQL/SPARQL, data-plane tool names, or research/domain payloads.

Review the exact plan and apply it once. Resume the same operation after an
external prerequisite; do not opportunistically create another installation.
A successful result is `activation-required`.

Tell the user:

> Start one new Codex task in this same project. Codex will load
> `.codex/config.toml` and connect directly to Gnolith.

Never claim live injection. On the new task, use Gnolith directly.
