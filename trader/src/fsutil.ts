import { renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Write via temp file + rename so a reader or a crash never sees a half-written file. */
export function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}
