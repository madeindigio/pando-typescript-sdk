/**
 * Deno-native tests for PandoClient (subprocess mode).
 *
 * Run with: deno test --allow-read --allow-env --allow-run tests/deno/client_test.ts
 *
 * Note: These tests use Deno.Command to create a fake pando script and verify
 * that PandoClient spawns the correct args and parses output correctly.
 */
import {
  assertEquals,
  assertExists,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

// ---------------------------------------------------------------------------
// Helper: write a temporary fake pando script that outputs a fixed JSON payload
// ---------------------------------------------------------------------------

async function createFakePandoScript(output: string, exitCode = 0): Promise<string> {
  const dir = await Deno.makeTempDir();
  const scriptPath = join(dir, "pando");
  // Shell script that writes output and exits with specified code
  await Deno.writeTextFile(
    scriptPath,
    `#!/bin/sh\necho '${output.replace(/'/g, "'\\''")}'\nexit ${exitCode}\n`
  );
  await Deno.chmod(scriptPath, 0o755);
  return scriptPath;
}

// ---------------------------------------------------------------------------
// PandoClient tests
// ---------------------------------------------------------------------------

Deno.test("PandoClient - run() parses JSON response", async () => {
  const { PandoClient } = await import("../../src/client.ts");

  const pandoPath = await createFakePandoScript('{"response":"Hello from pando!"}');

  const client = new PandoClient({
    cwd: Deno.cwd(),
    pandoPath,
  });

  const result = await client.run("Test prompt");
  assertEquals(result.response, "Hello from pando!");
});

Deno.test("PandoClient - run() throws on non-zero exit", async () => {
  const { PandoClient } = await import("../../src/client.ts");
  const { PandoConnectionError } = await import("../../src/exceptions.ts");

  const pandoPath = await createFakePandoScript("error output", 1);

  const client = new PandoClient({ cwd: Deno.cwd(), pandoPath });

  await assertRejects(
    () => client.run("Test prompt"),
    PandoConnectionError,
  );
});

Deno.test("PandoClient - stream() yields text chunks", async () => {
  const { PandoClient } = await import("../../src/client.ts");

  // Fake pando that outputs multiple lines
  const pandoPath = await createFakePandoScript("line one\nline two\nline three");

  const client = new PandoClient({ cwd: Deno.cwd(), pandoPath });

  const chunks: string[] = [];
  for await (const chunk of client.stream("Test prompt")) {
    chunks.push(chunk);
  }

  // Should have received the lines
  assertEquals(chunks.length > 0, true);
  assertEquals(chunks.join("").includes("line one"), true);
});
