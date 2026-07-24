# Alembic

Alembic is the Codex setup and diagnostics control plane for Gnolith. It is
never the Gnolith data plane or a proxy. After activation, ordinary work uses
Workshop directly through the project-scoped `gnolith` MCP connection.

It exposes only nine bounded operations: inspect, discover, plan, apply,
operation read, operation resume, diagnose, legacy inspect, and legacy adopt.
Docker-local provisioning is delegated to Seedbed's stable typed contract.
Remote services are connect-existing only.

The supported npm package is self-contained for Docker-local control: it has
one bundled `@gnolith/seedbed@0.4.0` runtime dependency whose component lock
must match `candidate-lock.json`. Installing Alembic therefore installs the
usable `@gnolith/seedbed/local-control` module without a separate registry or
co-install step. Alembic loads that module lazily, so connect-existing remote
inspection, planning, and verification do not initialize Seedbed or Docker.

## Safety model

- Plans bind the canonical project, config digest, endpoint, auth selector,
  expected identity, approved external Seedbed state selector, compatibility
  coordinates, expiry, and operation ID.
- Docker-local plans accept Seedbed's exact versioned
  `gnolith-seedbed-local-build-v1` selector, which is never pulled. They bind
  the exact Seedbed candidate, component-lock, rendered graph, and Compose
  bundle digests. Any registry image path remains SHA-256-digest-qualified.
- Credential selectors—not credential values—are accepted or stored. Protected
  bearer files accept canonical base64url text with at most one terminal LF;
  ambiguous whitespace, control characters, and malformed UTF-8 are rejected.
- Workshop verification performs authenticated MCP initialization, requires
  the final ordered 52-operation catalog and digest, and compares the exact
  schema-11/schema-2 `gnolith_status` evidence before config mutation.
- Alembic owns one exact marked URL block and refuses user-owned Gnolith tables.
- Apply is checkpointed, idempotent, resumable, and writes config last.
- Optional Docker-local semantic configuration is typed, fingerprint-bound,
  selector-only, and reduced to a redacted plan profile. Only the exact
  profile-approved Compose hosts `ollama:11434` and `qdrant:6333`, plus caller
  loopback addresses normalized to `host.docker.internal` with an explicit
  port, may use private HTTP when `allowPrivateEndpoint` is explicitly true.
  DNS aliases, arbitrary private targets, credentials, query strings,
  fragments, and redirects are rejected.
  Protected OpenAI-compatible profiles may verify ready with SQLite, or with
  Qdrant when Seedbed's immutable candidate enables that exact profile. Ollama
  remains degraded unless a separately bound immutable model artifact exists.
- Repair resumes only the recorded Seedbed operation. Alembic implements no
  restart behavior and reports activation-ready only after fresh authenticated
  Workshop identity, catalog, readiness, and status verification.
- Base IRIs are canonicalized once before request fingerprints and every
  downstream comparison, so trailing-slash aliases cannot create divergent
  plans or false unhealthy states.
- Every Seedbed plan/apply/resume/diagnose boundary is deadline- and
  cancellation-bound. Timeouts are recorded as stable redacted retryable
  outcomes; stopped Workshop state takes precedence over activation guidance.
- The default local Seedbed plan and receipt must bind identical Waystone
  evidence for `/app`, its exact manifest/CSS entrypoint, and the unshadowed
  reserved routes `/`, `/mcp`, `/health/live`, and `/health/ready`. Alembic
  validates that install evidence but owns no UI routes or assets.
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
bundle and Workshop package, runs packed semantic plan/apply/repair,
Workshop-52/no-pull, and nine-tool Alembic integration, then drives the actual
packed stdio MCP through bounded plan and valid/invalid legacy requests. A
fresh offline install of that archive must contain exactly one
`@gnolith/seedbed@0.4.0`, import its `local-control` export, construct all five
bounded control methods, and start Alembic's remote-capable nine-tool MCP. It
finally creates an unpublished package archive, CycloneDX SBOM, inventory, and
lowercase SHA-256
checksums. It never tags, releases, or publishes.

Uninstalling or disabling the Alembic plugin does not remove project config,
installations, volumes, backups, protected credentials, operation receipts, or
remote resources. Explicit removal is a separate approved plan and removes
only Alembic's marked project-config block.
