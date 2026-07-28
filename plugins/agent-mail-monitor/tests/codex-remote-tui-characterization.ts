#!/usr/bin/env -S deno run --allow-net

// Disposable Phase-0 characterization client. It deliberately does not answer
// App Server requests: the point is to observe which frames are fanned out while
// a stock remote TUI owns the interactive response surface.

const endpoint = Deno.args[0];
if (!endpoint?.startsWith("ws://")) {
  console.error("usage: codex-remote-tui-characterization.ts ws://HOST:PORT");
  Deno.exit(2);
}
const explicitThread = Deno.args[1];

const socket = new WebSocket(endpoint);
let nextId = 1;
let targetThread: string | undefined = explicitThread;
let turnStarted = false;

function emit(direction: "in" | "out", frame: unknown): void {
  console.log(JSON.stringify({
    at_ns: BigInt(Math.round(performance.now() * 1_000_000)).toString(),
    direction,
    frame,
  }));
}

function send(frame: unknown): void {
  emit("out", frame);
  socket.send(JSON.stringify(frame));
}

await new Promise<void>((resolve, reject) => {
  socket.onopen = () => resolve();
  socket.onerror = () => reject(new Error(`failed to connect to ${endpoint}`));
});

send({
  id: nextId++,
  method: "initialize",
  params: {
    clientInfo: {
      name: "codex-s2a-observer",
      title: "Codex S2A Observer",
      version: "1",
    },
    capabilities: null,
  },
});

function startExternalTurn(): void {
  if (turnStarted || !targetThread) return;
  turnStarted = true;
  send({
    id: nextId++,
    method: "turn/start",
    params: {
      threadId: targetThread,
      input: [{
        type: "text",
        text: "Reply exactly S2A_EXTERNAL_RENDER_OK. Do not call tools.",
        text_elements: [],
      }],
    },
  });
}

socket.onmessage = (event) => {
  const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
  emit("in", frame);
  if (frame.id === 1 && frame.result) send({ method: "initialized" });

  if (frame.method === "thread/started") {
    const params = frame.params as Record<string, unknown> | undefined;
    const thread = params?.thread as Record<string, unknown> | undefined;
    if (typeof thread?.id === "string") {
      targetThread = thread.id;
    }
  }

  if (
    !turnStarted &&
    targetThread &&
    frame.method === "mcpServer/startupStatus/updated"
  ) {
    const params = frame.params as Record<string, unknown> | undefined;
    if (params?.threadId === targetThread && params.status === "ready") {
      turnStarted = true;
      setTimeout(startExternalTurn, 500);
    }
  }
};

if (explicitThread) setTimeout(startExternalTurn, 1_000);

await new Promise<void>((resolve) => {
  const timeout = setTimeout(resolve, 45_000);
  socket.onclose = () => {
    clearTimeout(timeout);
    resolve();
  };
});
socket.close();
