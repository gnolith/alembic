import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { invariant } from "./errors.js";
import type { AlembicPlan, AlembicReceipt } from "./types.js";

export class OperationStore {
  constructor(private readonly projectRoot: string) {}

  private base(): string {
    return join(this.projectRoot, ".codex", "alembic");
  }

  async writePlan(plan: AlembicPlan): Promise<void> {
    await this.atomic(join(this.base(), "plans", `${plan.planId}.json`), JSON.stringify(plan, null, 2) + "\n", false);
  }

  async readPlan(planId: string): Promise<AlembicPlan> {
    validateId(planId, "plan_");
    return JSON.parse(await readFile(join(this.base(), "plans", `${planId}.json`), "utf8")) as AlembicPlan;
  }

  async writeReceipt(receipt: AlembicReceipt): Promise<void> {
    await this.atomic(
      join(this.base(), "operations", `${receipt.operationId}.json`),
      JSON.stringify(receipt, null, 2) + "\n",
      true
    );
  }

  async readReceipt(operationId: string): Promise<AlembicReceipt> {
    validateId(operationId, "op_");
    return JSON.parse(
      await readFile(join(this.base(), "operations", `${operationId}.json`), "utf8")
    ) as AlembicReceipt;
  }

  private async atomic(path: string, content: string, replace: boolean): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (!replace) {
        try {
          await open(path, constants.O_RDONLY);
          invariant(false, "id-collision", "Plan identifier already exists");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      await rename(temporary, path);
    } finally {
      if (handle) await handle.close();
      await rm(temporary, { force: true });
    }
  }
}

function validateId(value: string, prefix: "plan_" | "op_"): void {
  invariant(
    new RegExp(`^${prefix}[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, "u").test(value),
    "invalid-id",
    "Operation identifier is invalid"
  );
}
