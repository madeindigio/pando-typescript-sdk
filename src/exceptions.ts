/**
 * Error classes for the Pando SDK.
 */

/**
 * Base error class for all Pando SDK errors.
 * All SDK errors extend this class, so you can catch it broadly.
 */
export class PandoError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PandoError";
    // Restore the prototype chain for instanceof checks across transpiled code.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the `pando` binary cannot be found on the system.
 *
 * @example
 * ```typescript
 * try {
 *   const agent = new PandoAgent({ cwd: '/project' });
 *   await agent.connect();
 * } catch (err) {
 *   if (err instanceof PandoBinaryNotFoundError) {
 *     console.error('Install pando: https://github.com/digiogithub/pando');
 *   }
 * }
 * ```
 */
export class PandoBinaryNotFoundError extends PandoError {
  constructor(searchedPaths: string[]) {
    super(
      `pando binary not found. Searched: ${searchedPaths.join(", ")}\n` +
        `Install pando from https://github.com/digiogithub/pando or set the ` +
        `PANDO_PATH environment variable / pandoPath option to the binary location.`
    );
    this.name = "PandoBinaryNotFoundError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the connection to a pando subprocess fails or the process exits
 * unexpectedly.
 */
export class PandoConnectionError extends PandoError {
  /** The exit code of the subprocess, if available. */
  readonly exitCode: number | null;

  constructor(message: string, exitCode: number | null = null) {
    super(message);
    this.name = "PandoConnectionError";
    this.exitCode = exitCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a session-level operation fails (e.g. session not found,
 * duplicate session creation).
 */
export class PandoSessionError extends PandoError {
  /** The session ID involved in the error, if known. */
  readonly sessionId: string | undefined;

  constructor(message: string, sessionId?: string) {
    super(message);
    this.name = "PandoSessionError";
    this.sessionId = sessionId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when an operation exceeds its configured timeout.
 */
export class PandoTimeoutError extends PandoError {
  /** The timeout duration in milliseconds. */
  readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(`Operation "${operation}" timed out after ${timeoutMs}ms`);
    this.name = "PandoTimeoutError";
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a JSON-RPC 2.0 request returns an error response.
 */
export class PandoRPCError extends PandoError {
  /** The JSON-RPC error code. */
  readonly code: number;

  constructor(code: number, message: string) {
    super(`JSON-RPC error ${code}: ${message}`);
    this.name = "PandoRPCError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
