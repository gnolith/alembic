import { rm } from "node:fs/promises";

for (const path of ["dist", "dist-test", "artifacts"]) {
  await rm(new URL(`../${path}`, import.meta.url), { recursive: true, force: true });
}
