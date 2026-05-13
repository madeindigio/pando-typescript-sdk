/**
 * PandoSession — represents a single conversation session with a Pando agent.
 *
 * Obtained via {@link PandoAgent.createSession}. Each session maintains an
 * independent conversation history on the server side and can be used for
 * multiple turns of interaction.
 */

import type { JsonRpcTransport } from "./transport.js";
import { collectResponse } from "./events.js";
import type { AgentEvent } from "./types.js";
import { PandoSessionError } from "./exceptions.js";

/**
 * Options controlling how a prompt is sent to the agent.
 */
export interface SendOptions {
  /**
   * Abort signal to cancel an in-progress request.
   * When the signal fires the async generator is terminated; the server-side
   * agent continues running unless `session.cancel()` is also called.
   */
  signal?: AbortSignal | undefined;
}

/**
 * A conversation session with a Pando agent running in ACP stdio mode.
 *
 * @example
 * ```typescript
 * const session = await agent.createSession('Refactoring task');
 *
 * for await (const event of session.send('Refactor the auth module')) {
 *   if (event.type === 'content_delta') process.stdout.write(event.delta);
 * }
 * ```
 */
export class PandoSession {
  /** The ACP session ID. */
  readonly id: string;

  private readonly _transport: JsonRpcTransport;
  private _closed = false;

  /** @internal */
  constructor(id: string, transport: JsonRpcTransport) {
    this.id = id;
    this._transport = transport;
  }

  /**
   * Send a prompt to the agent and stream back events as an async generator.
   *
   * The generator yields {@link AgentEvent} values until a `response` or `error`
   * terminal event is received. Callers should always iterate to completion to
   * avoid leaking resources.
   *
   * @param prompt - The text prompt to send.
   * @param options - Optional send options (abort signal, etc.).
   *
   * @example
   * ```typescript
   * for await (const event of session.send('Fix the type errors')) {
   *   switch (event.type) {
   *     case 'content_delta': process.stdout.write(event.delta); break;
   *     case 'tool_call': console.log('[Tool]', event.toolCall.name); break;
   *     case 'error': throw new Error(event.error); break;
   *   }
   * }
   * ```
   */
  async *send(prompt: string, options?: SendOptions): AsyncGenerator<AgentEvent> {
    this._assertOpen();

    // Pre-create the event queue before sending the RPC so we don't miss events.
    this._transport.createSessionQueue(this.id);

    // Send the prompt (fire-and-forget from the RPC perspective — events come
    // back as async notifications, not as the RPC response).
    try {
      await this._transport.request("prompt/send", {
        sessionId: this.id,
        prompt: [{ type: "text", text: prompt }],
      });
    } catch (err) {
      // If the RPC itself fails propagate immediately.
      this._transport.completeSession(this.id);
      throw err;
    }

    // Consume events from the session queue.
    const iter = this._transport.getSessionEvents(this.id);
    const signal = options?.signal;

    for await (const event of iter) {
      if (signal?.aborted) {
        break;
      }
      yield event;
    }
  }

  /**
   * Send a prompt and return the complete response text as a string.
   *
   * This is a convenience wrapper around {@link send} that collects all events
   * and returns the accumulated response content.
   *
   * @param prompt - The text prompt to send.
   * @param options - Optional send options.
   * @returns The full assistant response text.
   *
   * @throws {PandoSessionError} If the agent returns an error event.
   *
   * @example
   * ```typescript
   * const response = await session.ask('What is a closure in JavaScript?');
   * console.log(response);
   * ```
   */
  async ask(prompt: string, options?: SendOptions): Promise<string> {
    const events: AgentEvent[] = [];

    for await (const event of this.send(prompt, options)) {
      events.push(event);
      if (event.type === "error") {
        throw new PandoSessionError(
          `Agent returned error: ${event.error}`,
          this.id
        );
      }
    }

    return collectResponse(events);
  }

  /**
   * Change the active persona for this session.
   *
   * Built-in personas: `assistant`, `software-engineer`, `qa`, `system-engineer`.
   *
   * @param name - Persona name.
   */
  async setPersona(name: string): Promise<void> {
    this._assertOpen();
    await this._transport.request("persona/set_session", {
      sessionId: this.id,
      name,
    });
  }

  /**
   * Change the active model for this session.
   *
   * @param modelId - Model identifier (e.g. `claude-sonnet-4-6`, `copilot.gpt-5.4`).
   */
  async setModel(modelId: string): Promise<void> {
    this._assertOpen();
    await this._transport.request("session/set_model", {
      sessionId: this.id,
      modelId,
    });
  }

  /**
   * Cancel any in-progress agent turn for this session.
   *
   * This sends a `cancel` notification to the ACP server. The server will
   * attempt to stop the running LLM call and tool executions.
   */
  async cancel(): Promise<void> {
    this._assertOpen();
    await this._transport.request("cancel", { sessionId: this.id });
  }

  /**
   * Close this session on the server side, releasing its resources.
   *
   * After calling `close()`, further calls to `send()` or `ask()` will throw
   * a {@link PandoSessionError}.
   */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    try {
      await this._transport.request("session/close", { sessionId: this.id });
    } catch {
      // Ignore errors on close (server may already have cleaned up).
    }
  }

  private _assertOpen(): void {
    if (this._closed) {
      throw new PandoSessionError(`Session ${this.id} is closed`, this.id);
    }
  }
}
