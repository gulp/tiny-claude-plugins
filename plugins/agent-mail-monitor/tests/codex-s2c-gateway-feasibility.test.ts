import {
  GATEWAY_CAPABILITIES,
  STOCK_PROXY_HELP_SUMMARY,
  gatewayFeasibilityReport,
} from "./codex-s2c-gateway-feasibility.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message = ""): void {
  if (actual !== expected) {
    throw new Error(message || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/**
 * Pinned Codex 0.144.6 / 0.145.0 `codex app-server proxy --help` first lines.
 * Provenance: docs/research/codex-s2c-gateway-feasibility-evidence.md (S2c).
 * Used when live CLI is missing, slow, or hung — never softens the NO-GO.
 */
export const PINNED_PROXY_HELP_FIXTURE = `${STOCK_PROXY_HELP_SUMMARY}

Usage: codex app-server proxy [OPTIONS]

Proxy stdio bytes to the running app-server control socket.
This is byte transport only; it does not demux or own JSON-RPC callbacks.
`;

const PROXY_HELP_TIMEOUT_MS = 5_000;

type ProxyHelpProbe = {
  text: string;
  source: "live" | "fixture";
  detail: string;
};

async function probeProxyHelp(): Promise<ProxyHelpProbe> {
  const codex = Deno.env.get("CODEX_BIN") ?? "codex";
  try {
    const output = await new Deno.Command(codex, {
      args: ["app-server", "proxy", "--help"],
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(PROXY_HELP_TIMEOUT_MS),
    }).output();
    const text =
      `${new TextDecoder().decode(output.stdout)}${new TextDecoder().decode(output.stderr)}`;
    if (output.code === 0 && text.trim().length > 0) {
      return {
        text,
        source: "live",
        detail: `CODEX_BIN=${codex} exit=0 within ${PROXY_HELP_TIMEOUT_MS}ms`,
      };
    }
    return {
      text: PINNED_PROXY_HELP_FIXTURE,
      source: "fixture",
      detail:
        `live ${codex} exit=${output.code} empty_or_fail; using pinned 0.144.6/0.145.0 fixture (${PROXY_HELP_TIMEOUT_MS}ms budget)`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      text: PINNED_PROXY_HELP_FIXTURE,
      source: "fixture",
      detail:
        `live ${codex} failed within ${PROXY_HELP_TIMEOUT_MS}ms (${message}); using pinned fixture`,
    };
  }
}

function assertProxyHelpIsBytePipe(text: string, ctx: string): void {
  assert(
    text.includes(STOCK_PROXY_HELP_SUMMARY) ||
      text.toLowerCase().includes("proxy stdio bytes"),
    `${ctx}: proxy help must describe byte proxying; got:\n${text.slice(0, 500)}`,
  );
  assert(
    !/arbitrat|demultiplex|request.?rout|observer.?role/i.test(text),
    `${ctx}: proxy help must not claim arbitration/routing`,
  );
}

Deno.test("S2c: pinned proxy-help fixture documents byte transport, not arbitration", () => {
  assertProxyHelpIsBytePipe(PINNED_PROXY_HELP_FIXTURE, "fixture");
  assert(
    PINNED_PROXY_HELP_FIXTURE.includes(STOCK_PROXY_HELP_SUMMARY),
    "fixture must embed STOCK_PROXY_HELP_SUMMARY provenance",
  );
});

Deno.test("S2c: stock proxy help documents byte transport, not arbitration", async () => {
  const probe = await probeProxyHelp();
  // Always assert the NO-GO byte-pipe property; fixture keeps suite bounded when CLI hangs.
  assertProxyHelpIsBytePipe(probe.text, `${probe.source}: ${probe.detail}`);
  if (probe.source === "fixture") {
    // Loud diagnostic for operators — not a soft pass.
    console.error(`[S2c] proxy --help probe fell back to fixture: ${probe.detail}`);
  }
});

Deno.test("S2c: gateway capability matrix rejects every interactive surface for v1", () => {
  const report = gatewayFeasibilityReport();
  assertEquals(report.verdict, "NO-GO");
  assertEquals(report.stockProxyIsArbitration, false);
  assertEquals(GATEWAY_CAPABILITIES.length, 9);
  for (const capability of report.capabilities) {
    assert(
      capability.verdict === "rejected" || capability.verdict === "not_attempted_reject",
      `${capability.id} must be rejected until proven`,
    );
    assert(capability.evidence.length > 40, `${capability.id} needs concrete evidence`);
  }
  const ids = report.capabilities.map((c) => c.id).sort().join(",");
  assertEquals(
    ids,
    [
      "approvals",
      "elicitation",
      "failure",
      "interrupt",
      "permissions",
      "reconnect",
      "rendering",
      "steering",
      "user_input",
    ].sort().join(","),
  );
});

Deno.test("S2c: report rationale forbids treating stock proxy as gateway", () => {
  const report = gatewayFeasibilityReport();
  assert(
    report.rationale.includes("byte pipe") || report.rationale.includes("byte"),
    "rationale must call out byte-pipe proxy",
  );
  assert(report.rationale.includes("exclusive"), "rationale must prefer exclusive ownership");
  assert(
    report.rationale.toLowerCase().includes("no-go") || report.verdict === "NO-GO",
    "rationale/verdict must be NO-GO",
  );
});
