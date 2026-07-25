import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = process.cwd();

test("plugin manifest identifies Alembic only and uses bounded stdio control plane", async () => {
  const manifest = JSON.parse(await readFile(join(root, "plugin", "manifest.json"), "utf8")) as {
    id: string;
    mcpServers: Record<string, unknown>;
    capabilities: { secrets: boolean };
  };
  assert.equal(manifest.id, "alembic");
  assert.deepEqual(Object.keys(manifest.mcpServers), ["alembic"]);
  assert.equal(manifest.capabilities.secrets, false);
});

test("installed MCP initializes as Alembic and lists the exact fixed catalog", async () => {
  const child = spawn(process.execPath, [join(root, "dist-test", "src", "mcp.js")], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  const lines: string[] = [];
  let stdout = "";
  let resolveResponses!: () => void;
  let rejectResponses!: (error: Error) => void;
  const responses = new Promise<void>((resolve, reject) => {
    resolveResponses = resolve;
    rejectResponses = reject;
  });
  const deadline = setTimeout(
    () => rejectResponses(new Error(`MCP returned only ${lines.length} responses before the deadline`)),
    5_000
  );
  child.once("error", rejectResponses);
  child.once("exit", (code) => {
    if (lines.length < 3) rejectResponses(new Error(`MCP exited with code ${String(code)} after ${lines.length} responses`));
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    while (stdout.includes("\n")) {
      const newline = stdout.indexOf("\n");
      const line = stdout.slice(0, newline);
      stdout = stdout.slice(newline + 1);
      if (line.length > 0) lines.push(line);
    }
    if (lines.length >= 3) resolveResponses();
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "not_an_alembic_tool", arguments: {} }
  }) + "\n");
  try {
    await responses;
  } finally {
    clearTimeout(deadline);
    child.kill();
  }
  const initialized = JSON.parse(lines[0]!) as { result: { serverInfo: { name: string }; instructions: string } };
  assert.equal(initialized.result.serverInfo.name, "alembic");
  assert.match(initialized.result.instructions, /never a proxy/u);
  const listed = JSON.parse(lines[1]!) as { result: { tools: { name: string }[] } };
  assert.equal(listed.result.tools.length, 9);
  assert.equal(listed.result.tools.some(({ name }) => name.startsWith("gnolith_")), false);
  const rejected = JSON.parse(lines[2]!) as {
    id: number | null;
    error: { data: { classification: string } };
  };
  assert.equal(rejected.id, 3);
  assert.equal(rejected.error.data.classification, "tool-not-found");
});

test("plugin installation semantics are project-local and activation requires a new task", async () => {
  const skill = await readFile(join(root, "skills", "alembic", "SKILL.md"), "utf8");
  assert.match(skill, /exact absolute current task directory/u);
  assert.match(skill, /Start one new Codex task in this same project/u);
  assert.match(skill, /use Gnolith directly/u);
  assert.match(skill, /Never claim live injection/u);
});
