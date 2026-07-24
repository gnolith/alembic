# Compatibility

| Component | Supported contract |
|---|---|
| Node.js | 22.x and 24.x |
| Codex desktop/CLI | Host metadata v1; explicit canonical-root confirmation fallback |
| Operating systems | Windows, macOS, Linux |
| Seedbed | `@gnolith/seedbed@0.4.0`, exact Alembic `SeedbedControl` adapter and `gnolith-seedbed-local-build-v1` never-pulled selector |
| Workshop | `@gnolith/workshop@0.5.0`, migration schema 11, operation schema 2, exact 52-operation catalog, MCP HTTP `/mcp`, identity `gnolith`, container workdir `/app` |
| Legacy Setup | exact source `@gnolith/codex-plugin@0.2.0`, schema 1; migration artifact 0.3.0 |
| Docker-local auth | `local-bearer-v1`, `GNOLITH_BEARER_TOKEN` |
| Remote auth | `remote-oauth-v1`, host-managed OAuth only |

Process/stdio Gnolith deployment and Codex Sites provisioning are unsupported.
Remote mode connects to an already deployed Workshop service only.
