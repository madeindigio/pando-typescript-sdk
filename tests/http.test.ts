import { describe, it, expect, beforeEach, jest } from "@jest/globals";

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------

const mockFetch = jest.fn<typeof fetch>();
global.fetch = mockFetch;

function mockJsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    body: null,
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob([])),
    formData: () => Promise.resolve(new FormData()),
    clone: () => mockJsonResponse(data, status),
    redirected: false,
    type: "default",
    url: "http://localhost:8765",
  } as unknown as Response;
}

function makeSSEBody(events: Array<{ event: string; data: unknown }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = events.map(
    ({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  );
  chunks.push("event: done\ndata: {}\n\n");

  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]));
      } else {
        controller.close();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PandoHttpClient", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("sessions", () => {
    it("list() returns sessions array", async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          sessions: [
            { id: "s1", title: "Session 1" },
            { id: "s2", title: "Session 2" },
          ],
        })
      );

      const { PandoHttpClient } = await import("../src/http.js");
      const client = new PandoHttpClient({ baseUrl: "http://localhost:8765" });
      const sessions = await client.sessions.list();

      expect(sessions).toHaveLength(2);
      expect(sessions[0]?.id).toBe("s1");
      expect(sessions[1]?.title).toBe("Session 2");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8765/api/v1/sessions",
        expect.objectContaining({ method: "GET" })
      );
    });

    it("create() posts to sessions endpoint", async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({ session: { id: "new-sess", title: "My Task" } })
      );

      const { PandoHttpClient } = await import("../src/http.js");
      const client = new PandoHttpClient({ baseUrl: "http://localhost:8765" });
      const session = await client.sessions.create("My Task");

      expect(session.id).toBe("new-sess");
      expect(session.title).toBe("My Task");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8765/api/v1/sessions",
        expect.objectContaining({ method: "POST" })
      );
    });

    it("delete() sends DELETE request", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ status: "deleted" }));

      const { PandoHttpClient } = await import("../src/http.js");
      const client = new PandoHttpClient({ baseUrl: "http://localhost:8765" });
      await client.sessions.delete("sess-123");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8765/api/v1/sessions/sess-123",
        expect.objectContaining({ method: "DELETE" })
      );
    });

    it("rename() sends PATCH with new title", async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({ session: { id: "sess-1", title: "New Title" } })
      );

      const { PandoHttpClient } = await import("../src/http.js");
      const client = new PandoHttpClient({ baseUrl: "http://localhost:8765" });
      const updated = await client.sessions.rename("sess-1", "New Title");

      expect(updated.title).toBe("New Title");
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8765/api/v1/sessions/sess-1",
        expect.objectContaining({ method: "PATCH" })
      );
    });

    it("sendMessage() streams SSE events", async () => {
      const sseBody = makeSSEBody([
        { event: "session", data: { sessionId: "s1", running: true } },
        { event: "content_delta", data: { text: "Hello, " } },
        { event: "content_delta", data: { text: "world!" } },
      ]);

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        body: sseBody,
        headers: new Headers({ "content-type": "text/event-stream" }),
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(""),
      } as unknown as Response);

      const { PandoHttpClient } = await import("../src/http.js");
      const client = new PandoHttpClient({ baseUrl: "http://localhost:8765" });

      const chunks: Array<{ event: string; delta: string | undefined }> = [];
      for await (const chunk of client.sessions.sendMessage("s1", "Hello")) {
        chunks.push({ event: chunk.event, delta: chunk.delta });
        if (chunk.event === "done") break;
      }

      const deltas = chunks.filter((c) => c.event === "content_delta");
      expect(deltas).toHaveLength(2);
      expect(deltas[0]?.delta).toBe("Hello, ");
      expect(deltas[1]?.delta).toBe("world!");
    });

    it("throws PandoConnectionError on HTTP error", async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({ error: "not found" }, 404)
      );

      const { PandoHttpClient } = await import("../src/http.js");
      const { PandoConnectionError } = await import("../src/exceptions.js");
      const client = new PandoHttpClient({ baseUrl: "http://localhost:8765" });

      await expect(client.sessions.list()).rejects.toBeInstanceOf(
        PandoConnectionError
      );
    });
  });

  describe("models", () => {
    it("list() returns models array", async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({
          models: [
            { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
            { id: "copilot.gpt-5.4", name: "GPT-5.4", provider: "copilot" },
          ],
        })
      );

      const { PandoHttpClient } = await import("../src/http.js");
      const client = new PandoHttpClient({ baseUrl: "http://localhost:8765" });
      const models = await client.models.list();

      expect(models).toHaveLength(2);
      expect(models[0]?.id).toBe("claude-sonnet-4-6");
    });

    it("setActive() sends PUT with model id", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ model: "claude-sonnet-4-6" }));

      const { PandoHttpClient } = await import("../src/http.js");
      const client = new PandoHttpClient({ baseUrl: "http://localhost:8765" });
      await client.models.setActive("claude-sonnet-4-6");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8765/api/v1/models/active",
        expect.objectContaining({ method: "PUT" })
      );
    });
  });

  describe("personas", () => {
    it("list() returns personas array", async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({ personas: ["assistant", "software-engineer", "qa"] })
      );

      const { PandoHttpClient } = await import("../src/http.js");
      const client = new PandoHttpClient({ baseUrl: "http://localhost:8765" });
      const personas = await client.personas.list();

      expect(personas).toEqual(["assistant", "software-engineer", "qa"]);
    });

    it("setActive() sends PUT to personas/active", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ active: "software-engineer" }));

      const { PandoHttpClient } = await import("../src/http.js");
      const client = new PandoHttpClient({ baseUrl: "http://localhost:8765" });
      await client.personas.setActive("software-engineer");

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:8765/api/v1/personas/active",
        expect.objectContaining({ method: "PUT" })
      );
    });

    it("getActive() returns active persona", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ active: "qa" }));

      const { PandoHttpClient } = await import("../src/http.js");
      const client = new PandoHttpClient({ baseUrl: "http://localhost:8765" });
      const active = await client.personas.getActive();

      expect(active).toBe("qa");
    });
  });

  describe("health()", () => {
    it("returns true when server is healthy", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: "ok" }),
      } as unknown as Response);

      const { PandoHttpClient } = await import("../src/http.js");
      const client = new PandoHttpClient({ baseUrl: "http://localhost:8765" });
      const healthy = await client.health();
      expect(healthy).toBe(true);
    });

    it("returns false when fetch throws", async () => {
      mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

      const { PandoHttpClient } = await import("../src/http.js");
      const client = new PandoHttpClient({ baseUrl: "http://localhost:8765" });
      const healthy = await client.health();
      expect(healthy).toBe(false);
    });

    it("includes Authorization header when apiToken is provided", async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({ sessions: [] })
      );

      const { PandoHttpClient } = await import("../src/http.js");
      const client = new PandoHttpClient({
        baseUrl: "http://localhost:8765",
        apiToken: "secret-token",
      });
      await client.sessions.list();

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer secret-token");
    });
  });
});
