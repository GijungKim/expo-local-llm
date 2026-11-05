import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function lintSource() {
  const result = spawnSync("bun", ["run", "lint:typed", "--format", "json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.error, undefined, `Could not run typed lint: ${result.stderr}`);
  assert.equal(result.signal, null, `Typed lint was interrupted: ${result.stderr}`);
  try {
    const report = JSON.parse(result.stdout);
    assert.ok(Array.isArray(report.diagnostics), "Typed lint must report diagnostics");
    return { status: result.status, diagnostics: report.diagnostics };
  } catch (cause) {
    throw new Error(
      `Typed lint returned invalid output (exit ${result.status}):\n${result.stderr}\n${result.stdout}`,
      { cause },
    );
  }
}

test("typed lint preserves Promise and anti-slop enforcement", { timeout: 30_000 }, () => {
  const directory = mkdtempSync(join(repositoryRoot, "src", ".typed-lint-"));
  const fixture = join(directory, "enforcement.ts");
  try {
    writeFileSync(fixture, `
export async function validUsage() {
  const ready = await Promise.resolve(true);
  const value = { count: 1 };
  return ready ? value.count : 0;
}
`);
    const valid = lintSource();
    assert.equal(valid.status, 0, "Valid source must pass typed lint");
    assert.deepEqual(valid.diagnostics.filter((item) => item.filename.endsWith(basename(fixture))), []);

    writeFileSync(fixture, `
export function invalidUsage() {
  Promise.resolve(1);
  if (Promise.resolve(true)) {
    return Reflect.get({ count: 1 }, "count");
  }
  return 0;
}
`);
    const invalid = lintSource();
    assert.equal(invalid.status, 1, "Invalid source must fail typed lint");
    const errors = invalid.diagnostics
      .filter((item) => item.filename.endsWith(basename(fixture)) && item.severity === "error")
      .map((item) => item.code);
    for (const code of [
      "typescript(no-floating-promises)",
      "typescript(no-misused-promises)",
      "anti-slop(no-reflect-get)",
    ]) {
      assert.ok(errors.includes(code), `Missing expected error ${code}: ${errors.join(", ")}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
