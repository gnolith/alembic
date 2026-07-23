# Threat model

Alembic assumes project files, endpoint responses, DNS, redirects, inherited
environment, legacy bundles, and concurrent local writers may be hostile.

Controls include canonical-root attestation, symlink/junction rejection,
nearest-config binding, raw-byte digests, expiry and replay defense, atomic
compare-and-swap config writes, strict endpoint policy, redirect refusal,
bounded authenticated MCP responses, exact server/catalog/status comparison,
credential-selector-only schemas, output redaction, and config-last mutation.

Alembic has no arbitrary command, headers, environment maps, data-plane tool
arguments, database driver, query language, Workshop dispatcher, Compose
renderer, backup implementation, or deployment integration. Seedbed receives
only its fixed typed request/plan/operation contracts.
