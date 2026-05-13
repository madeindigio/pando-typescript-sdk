/**
 * PandoClient — simple non-interactive subprocess mode.
 *
 * Runs `pando -p "..."` as a one-shot subprocess for single-turn prompts.
 * For multi-turn conversations or streaming, use {@link PandoAgent} instead.
 *
 * @example
 * ```typescript
 * import { PandoClient } from '@pando-ai/sdk';
 *
 * const client = new PandoClient({ cwd: '/path/to/project' });
 *
 * // Promise-based (JSON output)
 * const result = await client.run('Fix all lint errors', { allowAllTools: true });
 * console.log(result.response);
 *
 * // Streaming text output
 * for await (const chunk of client.stream('Explain this code')) {
 *   process.stdout.write(chunk);
 * }
 * ```
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { findPandoBinary } from "./transport.js";
import {
  PandoConnectionError,
  PandoTimeoutError,
} from "./exceptions.js";
import type { RunResult } from "./types.js";

/**
 * Options for constructing a {@link PandoClient}.
 */
export interface PandoClientOptions {
  /**
   * Working directory for the pando process.
   * Defaults to `process.cwd()`.
   */
  cwd?: string | undefined;
  /**
   * Model identifier to use (e.g. `copilot.gpt-5.4`).
   * When omitted the model configured in `.pando.toml` is used.
   */
  model?: string | undefined;
  /**
   * Path to the `pando` binary.
   * Resolved automatically if omitted.
   */
  pandoPath?: string | undefined;
  /**
   * Maximum time in milliseconds to wait for a run to complete.
   * Defaults to `300_000` (5 minutes).
   */
  timeout?: number | undefined;
}

/**
 * Options for a single {@link PandoClient.run} call.
 */
export interface RunOptions {
  /**
   * When `true` all tool permission prompts are auto-approved (`--yolo` flag).
   */
  allowAllTools?: boolean | undefined;
  /**
   * Model override for this specific run.
   */
  model?: string | undefined;
  /**
   * Working directory override for this specific run.
   */
  cwd?: string | undefined;
  /**
   * Timeout override in milliseconds for this run.
   */
  timeout?: number | undefined;
}

/**
 * Simple client for running one-shot `pando -p "..."` commands.
 *
 * Each `run()` call spawns a fresh subprocess and collects the result.
 * For persistent sessions, use {@link PandoAgent} instead.
 */
export class PandoClient {
  private readonly _pandoPath: string;
  private readonly _cwd: string;
  private readonly _model: string | undefined;
  private readonly _timeout: number;

  /**
   * @param options - Client configuration options.
   */
  constructor(options: PandoClientOptions = {}) {
    this._pandoPath = findPandoBinary(options.pandoPath);
    this._cwd = options.cwd ?? process.cwd();
    this._model = options.model;
    this._timeout = options.timeout ?? 300_000;
  }

  /**
   * Run a single prompt and return the complete response.
   *
   * Uses `-f json` output format so the response is reliably parsed.
   *
   * @param prompt - The prompt text to send to pando.
   * @param options - Per-run options (tool approval, model override, etc.).
   * @returns A {@link RunResult} with the response text and raw JSON.
   *
   * @throws {PandoTimeoutError} If the run exceeds the configured timeout.
   * @throws {PandoConnectionError} If pando exits with a non-zero code.
   *
   * @example
   * ```typescript
   * const result = await client.run('Fix all lint errors', { allowAllTools: true });
   * console.log(result.response);
   * ```
   */
  async run(prompt: string, options: RunOptions = {}): Promise<RunResult> {
    const args = this._buildArgs(prompt, "json", options);
    const cwd = options.cwd ?? this._cwd;
    const timeoutMs = options.timeout ?? this._timeout;

    return new Promise<RunResult>((resolve, reject) => {
      const child = spawn(this._pandoPath, args, {
        cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new PandoTimeoutError("pando run", timeoutMs));
      }, timeoutMs);

      child.on("close", (code) => {
        clearTimeout(timer);

        if (code !== 0) {
          reject(
            new PandoConnectionError(
              `pando exited with code ${code}. stderr: ${stderr.slice(0, 500)}`,
              code ?? -1
            )
          );
          return;
        }

        // Find the last complete JSON object in stdout.
        const jsonLine = this._extractJsonOutput(stdout);
        if (!jsonLine) {
          reject(
            new PandoConnectionError(
              `pando produced no parseable JSON output. stdout: ${stdout.slice(0, 500)}`
            )
          );
          return;
        }

        try {
          const parsed = JSON.parse(jsonLine) as Record<string, unknown>;
          resolve({
            response: typeof parsed["response"] === "string" ? parsed["response"] : stdout.trim(),
            sessionId: typeof parsed["sessionId"] === "string" ? parsed["sessionId"] : "",
            raw: parsed,
          });
        } catch {
          reject(
            new PandoConnectionError(
              `Failed to parse pando JSON output: ${jsonLine.slice(0, 200)}`
            )
          );
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new PandoConnectionError(`Failed to spawn pando: ${err.message}`));
      });

      // Close stdin immediately (no input from us in this mode).
      child.stdin.end();
    });
  }

  /**
   * Stream text output from a single prompt.
   *
   * Uses `-f text` output format so content is written incrementally to stdout
   * by pando. The generator yields raw text chunks as they arrive.
   *
   * @param prompt - The prompt text to send to pando.
   * @param options - Per-run options.
   *
   * @throws {PandoTimeoutError} If the run exceeds the configured timeout.
   * @throws {PandoConnectionError} If pando exits with a non-zero code.
   *
   * @example
   * ```typescript
   * for await (const chunk of client.stream('Explain this module')) {
   *   process.stdout.write(chunk);
   * }
   * ```
   */
  async *stream(prompt: string, options: RunOptions = {}): AsyncGenerator<string> {
    const args = this._buildArgs(prompt, "text", options);
    const cwd = options.cwd ?? this._cwd;
    const timeoutMs = options.timeout ?? this._timeout;

    const child = spawn(this._pandoPath, args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdin.end();

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    try {
      for await (const line of rl) {
        yield line + "\n";
      }
    } finally {
      clearTimeout(timer);
      rl.close();
    }

    // Wait for the process to exit.
    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) => {
        if (timedOut) {
          reject(new PandoTimeoutError("pando stream", timeoutMs));
        } else if (code !== 0) {
          reject(
            new PandoConnectionError(
              `pando exited with code ${code}`,
              code ?? -1
            )
          );
        } else {
          resolve();
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _buildArgs(
    prompt: string,
    format: "json" | "text",
    options: RunOptions
  ): string[] {
    const args: string[] = ["-p", prompt, "-f", format];

    const model = options.model ?? this._model;
    if (model) {
      args.push("-m", model);
    }

    if (options.allowAllTools) {
      args.push("--yolo");
    }

    return args;
  }

  /**
   * Extract the last JSON object or line that looks like `{"response":...}` from stdout.
   * pando may emit progress lines before the final JSON object.
   */
  private _extractJsonOutput(output: string): string | undefined {
    const lines = output.split("\n").reverse();
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        return trimmed;
      }
    }
    // Fallback: try the entire output as JSON.
    const trimmedAll = output.trim();
    if (trimmedAll.startsWith("{")) {
      return trimmedAll;
    }
    return undefined;
  }
}
