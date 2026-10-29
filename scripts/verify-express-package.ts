import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

async function main() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spektrace-express-consumer-"));
  try {
    const target = path.join(directory, "node_modules", "@spektrace", "express-monitoring"); await mkdir(target, { recursive: true });
    await cp("packages/express-monitoring/dist", path.join(target, "dist"), { recursive: true });
    await cp("packages/express-monitoring/package.json", path.join(target, "package.json"));
    await readFile(path.join(target, "dist", "index.d.ts"), "utf8");
    const exercise = `const monitor=createExpressMonitor({baseUrl:'http://127.0.0.1',ingestionToken:'st_ingest_v1.'+crypto.randomUUID()+'.'+'a'.repeat(43),apiKey:'synthetic'}); if(typeof monitor.middleware!=='function'||typeof monitor.operation!=='function')process.exit(1); monitor.close();`;
    for (const mode of ["commonjs", "module"]) {
      const imports = mode === "commonjs"
        ? `const {createExpressMonitor}=require('@spektrace/express-monitoring'); const crypto=require('node:crypto');`
        : `import {createExpressMonitor} from '@spektrace/express-monitoring'; import crypto from 'node:crypto';`;
      const result = spawnSync(process.execPath, ["--input-type", mode, "-e", imports + exercise], { cwd: directory, stdio: "pipe", windowsHide: true });
      if (result.status !== 0) throw new Error("Standalone package load failed");
    }
    console.log("Standalone CommonJS and ESM consumers loaded the compiled package exports and declarations outside the repository, with no application dependencies.");
  } finally {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("spektrace-express-consumer-")) throw new Error("Unexpected temporary directory");
    await rm(resolved, { recursive: true, force: true });
  }
}
void main().catch(() => { console.error("Standalone Express package check failed; details withheld."); process.exitCode = 1; });
