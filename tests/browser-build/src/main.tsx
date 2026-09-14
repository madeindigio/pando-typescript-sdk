/**
 * PANDO-US-0006 acceptance fixture.
 *
 * A minimal React 18 component that exercises every kind of export
 * `@pando-ai/sdk/agui/client` offers (a class, functions, and re-exported
 * protocol types) so a dead-code-eliminating bundler cannot optimize the
 * import away and hide a resolution problem.
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PandoAguiClient, parseSSE, randomId, DEFAULT_AGUI_PATH } from "@pando-ai/sdk/agui/client";
import type { AguiEvent, PandoState } from "@pando-ai/sdk/agui/client";

// Referenced only for its type; proves types.ts is reachable through this subpath.
type _AssertStateShape = PandoState["subAgents"];

function App(): JSX.Element {
  const [status, setStatus] = useState("idle");

  useEffect(() => {
    const client = new PandoAguiClient({
      baseUrl: "http://localhost:8090",
      path: DEFAULT_AGUI_PATH,
      token: undefined,
    });
    const threadId = randomId("thread");
    // No network call: this fixture only needs to prove the bundle resolves
    // and runs in a browser, not that it can reach a live Pando server.
    setStatus(`ready: ${client.agentUrl()} thread=${threadId} parseSSE=${typeof parseSSE}`);
  }, []);

  const handleEvent = (event: AguiEvent): string => event.type;
  void handleEvent;

  return <p data-testid="status">{status}</p>;
}

const container = document.getElementById("root");
if (!container) throw new Error("missing #root element");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
