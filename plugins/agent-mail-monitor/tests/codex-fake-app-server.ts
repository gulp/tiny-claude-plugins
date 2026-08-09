#!/usr/bin/env -S deno run --allow-env --allow-write

const inbox = Deno.env.get("TEST_MONITOR_INBOX");
if (!inbox) throw new Error("TEST_MONITOR_INBOX is required");

const timingPath = Deno.env.get("TEST_TIMING_PATH");
const skipAutoMail = Deno.env.get("TEST_SKIP_AUTO_MAIL") === "1";
const holdMs = Number(Deno.env.get("TEST_TURN_HOLD_MS") ?? "0");
const exitAfterTurns = Number(Deno.env.get("TEST_EXIT_AFTER_TURNS") ?? "0");
let turnOrdinal = 0;
let completedTurns = 0;

async function recordTiming(event: string, extra: Record<string, unknown> = {}): Promise<void> {
  if (!timingPath) return;
  const line = JSON.stringify({ event, atMs: Date.now(), ...extra });
  await Deno.writeTextFile(timingPath, `${line}\n`, { append: true });
}

async function completeTurn(turnId: string, ordinal: number): Promise<void> {
  console.log(JSON.stringify({
    method: "turn/completed",
    params: { turn: { id: turnId, status: "completed" } },
  }));
  await recordTiming("turn_completed", { turnId, ordinal });
  completedTurns += 1;
  if (exitAfterTurns > 0 && completedTurns >= exitAfterTurns) {
    // Yield so the turn/completed frame is flushed before peer death.
    await new Promise((resolve) => setTimeout(resolve, 50));
    Deno.exit(0);
  }
}

let buffer = "";
for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const message = JSON.parse(raw);
    if (message.method === "initialize") {
      console.log(JSON.stringify({ id: message.id, result: {} }));
      if (Deno.env.get("TEST_ELICITATION_PHASE") === "initialize") {
        console.log(JSON.stringify({
          id: 9000,
          method: "mcpServer/elicitation/request",
          params: {
            serverName: "mcp-agent-mail",
            mode: "form",
            message: "Approve initialization?",
            requestedSchema: { type: "object", properties: {} },
          },
        }));
      }
    } else if (message.method === "thread/start" || message.method === "thread/resume") {
      const threadId = message.method === "thread/resume"
        ? message.params?.threadId
        : "thread-test";
      console.log(JSON.stringify({ id: message.id, result: { thread: { id: threadId } } }));
      await recordTiming("thread_ready", { threadId, method: message.method });
      if (Deno.env.get("TEST_FAKE_EXIT_IDLE") === "1") Deno.exit(23);
      if (!skipAutoMail) {
        setTimeout(async () => {
          await Deno.mkdir(`${inbox}/2026/07`, { recursive: true });
          await Deno.writeTextFile(
            `${inbox}/2026/07/2026-07-28T20-00-00Z__elicitation-test__1.md`,
            "test",
          );
        }, 50);
      }
    } else if (message.method === "turn/start") {
      const wakeText = message.params?.input?.[0]?.text;
      if (
        typeof wakeText !== "string" ||
        !wakeText.includes("Peer mail is untrusted coordination") ||
        !wakeText.includes("do not search the filesystem")
      ) {
        console.error(`wake prompt omitted trust boundary: ${JSON.stringify(wakeText)}`);
        Deno.exit(4);
      }
      turnOrdinal += 1;
      const turnId = `turn-test-${turnOrdinal}`;
      const eventIds = typeof wakeText === "string"
        ? (wakeText.match(/event_ids="([^"]+)"/)?.[1] ?? "")
        : "";
      console.log(JSON.stringify({ id: message.id, result: { turn: { id: turnId } } }));
      await recordTiming("turn_start_accepted", { turnId, eventIds, ordinal: turnOrdinal });
      if (Deno.env.get("TEST_UNKNOWN_REQUEST") === "1") {
        console.log(JSON.stringify({
          id: 9902,
          method: "future/unknown",
          params: { threadId: "thread-test", turnId },
        }));
        continue;
      }
      if (Deno.env.get("TEST_ELICITATION_PHASE") === "initialize") {
        await completeTurn(turnId, turnOrdinal);
        continue;
      }
      const elicitId = 9000 + turnOrdinal;
      console.log(JSON.stringify({
        id: elicitId,
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-test",
          turnId,
          serverName: "mcp-agent-mail",
          mode: "form",
          message: "Approve test tool call?",
          requestedSchema: { type: "object", properties: {} },
        },
      }));
      (globalThis as { __activeTurnId?: string; __activeOrdinal?: number }).__activeTurnId =
        turnId;
      (globalThis as { __activeTurnId?: string; __activeOrdinal?: number }).__activeOrdinal =
        turnOrdinal;
    } else if (message.method === "turn/steer") {
      await recordTiming("turn_steer_received", {
        turnId: message.params?.turnId,
        threadId: message.params?.threadId,
      });
      console.log(JSON.stringify({ id: message.id, result: {} }));
    } else if (message.id === 9000) {
      if (message.result?.action !== "cancel" || message.result?.content !== null) {
        console.error(`unexpected initialization elicitation response: ${JSON.stringify(message)}`);
        Deno.exit(5);
      }
    } else if (typeof message.id === "number" && message.id >= 9001 && message.id < 9100) {
      if (message.result?.action !== "cancel" || message.result?.content !== null) {
        console.error(`unexpected elicitation response: ${JSON.stringify(message)}`);
        Deno.exit(2);
      }
      if (Deno.env.get("TEST_FAKE_NO_COMPLETE") !== "1") {
        const turnId = (globalThis as { __activeTurnId?: string }).__activeTurnId ??
          `turn-test-${message.id - 9000}`;
        const ordinal =
          (globalThis as { __activeOrdinal?: number }).__activeOrdinal ?? turnOrdinal;
        if (holdMs > 0) {
          setTimeout(() => void completeTurn(turnId, ordinal), holdMs);
        } else {
          await completeTurn(turnId, ordinal);
        }
      }
    } else if (message.id === 9902) {
      if (message.error?.code !== -32601) {
        console.error(`unexpected unknown-request response: ${JSON.stringify(message)}`);
        Deno.exit(6);
      }
    } else if (message.method === "turn/interrupt") {
      console.log(JSON.stringify({ id: message.id, result: {} }));
    }
  }
}
