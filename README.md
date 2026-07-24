# Alembic

Alembic is the Codex setup and diagnostics control plane for Gnolith. It is
never the Gnolith data plane or a proxy. After activation, ordinary work uses
Workshop directly through the project-scoped `gnolith` MCP connection.

It exposes only nine bounded operations: inspect, discover, plan, apply,
operation read, operation resume, diagnose, legacy inspect, and legacy adopt.
Docker-local provisioning is delegated to Seedbed's stable typed contract.
Remote services are connect-existing only.

## Safety model

- Plans bind the canonical project, config digest, endpoint, auth selector,
  expected identity, approved external Seedbed state selector, compatibility
  coordinates, expiry, and operation ID.
- Docker-local plans accept Seedbed's exact versioned
  `gnolith-seedbed-local-build-v1` selector, which is never pulled. They bind
  the exact Seedbed candidate, component-lock, rendered graph, and Compose
  bundle digests. Any registry image path remains SHA-256-digest-qualified.
- Credential selectors—not credential values—are accepted or stored.
- Workshop verification performs authenticated MCP initialization, requires
  the final ordered 52-operation catalog and digest, and compares the exact
  schema-11/schema-2 `gnolith_status` evidence before config mutation.
- Alembic owns one exact marked URL block and refuses user-owned Gnolith tables.
- Apply is checkpointed, idempotent, resumable, and writes config last.
- Optional Docker-local semantic configuration is typed, fingerprint-bound,
  selector-only, and reduced to a redacted plan profile. Only the exact
  profile-approved Compose hosts `ollama:11434` and `qdrant:6333` may use
  private HTTP; arbitrary private semantic targets are rejected. Protected
  OpenAI-compatible profiles may verify ready with SQLite or Qdrant. Ollama
  remains degraded unless a separately bound immutable model artifact exists.
- Repair resumes only the recorded Seedbed operation. Alembic implements no
  restart behavior and reports activation-ready only after fresh authenticated
  Workshop identity, catalog, readiness, and status verification.
- Success is `activation-required`: start a new Codex task in the same project.

See [THREAT_MODEL.md](THREAT_MODEL.md), [COMPATIBILITY.md](COMPATIBILITY.md),
and [SECURITY.md](SECURITY.md).

## Development

Requires Node.js 22 or newer.

```text
npm ci
npm run gate
npm run candidate
```

`candidate` verifies the exact Seedbed package/component-lock/graph/Compose
bundle and Workshop package, runs a packed semantic plan/apply/repair,
Workshop-52/no-pull, and nine-tool Alembic integration, then creates an
unpublished package archive, CycloneDX SBOM, inventory, and lowercase SHA-256
checksums. It never tags, releases, or publishes.

Uninstalling or disabling the Alembic plugin does not remove project config,
installations, volumes, backups, protected credentials, operation receipts, or
remote resources. Explicit removal is a separate approved plan and removes
only Alembic's marked project-config block.
