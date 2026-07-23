# Compatibility

| Component | Supported contract |
|---|---|
| Node.js | 22.x and 24.x |
| Codex desktop/CLI | Host metadata v1; explicit canonical-root confirmation fallback |
| Operating systems | Windows, macOS, Linux |
| Seedbed | `@gnolith/seedbed@0.1.0`, `SeedbedControl` stable contract |
| Workshop | `@gnolith/workshop@0.1.0`, MCP HTTP `/mcp`, identity `gnolith` |
| Legacy Setup | `@gnolith/codex-plugin@0.2.0`, handoff schema 1 only |
| Docker-local auth | `local-bearer-v1`, `GNOLITH_BEARER_TOKEN` |
| Remote auth | `remote-oauth-v1`, host-managed OAuth only |

Process/stdio Gnolith deployment and Codex Sites provisioning are unsupported.
Remote mode connects to an already deployed Workshop service only.
