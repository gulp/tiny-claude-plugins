/// <reference lib="deno.window" />

import {
  AppServerTransport,
  AppServerTransportError,
  type JsonObject,
} from "../src/owner/app_server_transport.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`expected ${Deno.inspect(expected)}, got ${Deno.inspect(actual)}`);
  }
}

async function expectCode(
  promise: Promise<unknown>,
  code: AppServerTransportError["code"],
): Promise<void> {
  try {
    await promise;
    throw new Error(`expected ${code}`);
  } catch (error) {
    assert(error instanceof AppServerTransportError, String(error));
    assertEquals(error.code, code);
  }
}

function harness(options: {
  timeout?: number;
  processExit?: Promise<{ code: number }>;
  onServerRequest?: ConstructorParameters<typeof AppServerTransport>[0]["onServerRequest"];
  onNotification?: ConstructorParameters<typeof AppServerTransport>[0]["onNotification"];
} = {}) {
  const appToClient = new TransformStream<Uint8Array>();
  const clientToApp = new TransformStream<Uint8Array>();
  const appWriter = appToClient.writable.getWriter();
  const appReader = clientToApp.readable
    .pipeThrough(new TextDecoderStream())
    .getReader();
  const transport = new AppServerTransport({
    readable: appToClient.readable,
    writable: clientToApp.writable,
    requestTimeoutMs: options.timeout ?? 1_000,
    processExit: options.processExit,
    onServerRequest: options.onServerRequest,
    onNotification: options.onNotification,
  });
  const encoder = new TextEncoder();
  return {
    transport,
    appWriter,
    async sendRaw(value: string) {
      await appWriter.write(encoder.encode(value));
    },
    async read(): Promise<JsonObject> {
      const { value, done } = await appReader.read();
      assert(!done && value !== undefined, "expected client frame");
      return JSON.parse(value.trim());
    },
  };
}

Deno.test("C2 correlates concurrent requests across fragmented frames", async () => {
  const h = harness();
  const first = h.transport.request("one", { n: 1 });
  const one = await h.read();
  const second = h.transport.request("two", { n: 2 });
  const two = await h.read();

  const response = `${JSON.stringify({ id: two.id, result: { value: 2 } })}\n` +
    `${JSON.stringify({ id: one.id, result: { value: 1 } })}\n`;
  await h.sendRaw(response.slice(0, 7));
  await h.sendRaw(response.slice(7, 23));
  await h.sendRaw(response.slice(23));

  assertEquals(await second, { value: 2 });
  assertEquals(await first, { value: 1 });
  await h.transport.close();
});

Deno.test("C2 initialize performs request then initialized notification", async () => {
  const h = harness();
  const initialized = h.transport.initialize({
    name: "agent-mail-codex",
    version: "0.1.0-phase0",
  });
  const request = await h.read();
  assertEquals(request.method, "initialize");
  await h.sendRaw(`${JSON.stringify({ id: request.id, result: { protocolVersion: "v2" } })}\n`);
  const notification = await h.read();
  assertEquals(notification, { method: "initialized" });
  assertEquals(await initialized, { protocolVersion: "v2" });
  await h.transport.close();
});

Deno.test("C2 emits typed server requests and notifications", async () => {
  const requests: unknown[] = [];
  const notifications: unknown[] = [];
  const h = harness({
    onServerRequest: (request) => {
      requests.push(request);
    },
    onNotification: (notification) => {
      notifications.push(notification);
    },
  });
  await h.sendRaw(
    `${
      JSON.stringify({
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: { command: "false" },
      })
    }\n${JSON.stringify({ method: "turn/completed", params: { turn: { id: "t1" } } })}\n`,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(requests, [{
    id: "approval-1",
    kind: "approval",
    method: "item/commandExecution/requestApproval",
    params: { command: "false" },
  }]);
  assertEquals(notifications, [{
    method: "turn/completed",
    params: { turn: { id: "t1" } },
  }]);
  await h.transport.close();
});

Deno.test("C2 request timeout is typed without poisoning other requests", async () => {
  const h = harness({ timeout: 10 });
  const pending = h.transport.request("slow");
  await h.read();
  await expectCode(pending, "timeout");
  assert(h.transport.healthy);
  await h.transport.close();
});

Deno.test("C2 process exit rejects pending requests and marks unhealthy", async () => {
  const exit = Promise.withResolvers<{ code: number }>();
  const h = harness({ processExit: exit.promise });
  const pending = h.transport.request("waiting");
  await h.read();
  exit.resolve({ code: 17 });
  await expectCode(pending, "process_exit");
  assertEquals(h.transport.healthy, false);
  await expectCode(h.transport.request("after-exit"), "unhealthy");
  await h.transport.close();
});

Deno.test("C2 unknown server request receives -32601 then marks unhealthy", async () => {
  const h = harness();
  await h.sendRaw(`${JSON.stringify({ id: 91, method: "future/dangerous", params: {} })}\n`);
  const response = await h.read();
  assertEquals(response, {
    id: 91,
    error: {
      code: -32601,
      message: "unsupported App Server request: future/dangerous",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(h.transport.healthy, false);
  assertEquals(h.transport.failure?.code, "protocol");
  await expectCode(h.transport.notify("after-failure"), "unhealthy");
  await h.transport.close();
});

Deno.test("C2 malformed and truncated frames fail closed", async () => {
  const malformed = harness();
  await malformed.sendRaw("{not-json}\n");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(malformed.transport.failure?.code, "protocol");
  await malformed.transport.close();

  const truncated = harness();
  await truncated.sendRaw('{"id":1');
  await truncated.appWriter.close();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEquals(truncated.transport.failure?.code, "protocol");
  await truncated.transport.close();
});
