/** S2c gateway feasibility: structured reject criteria (tcp-efp.1.5). */

export type CapabilityVerdict = "proven" | "rejected" | "not_attempted_reject";

export interface GatewayCapability {
  id: string;
  title: string;
  /** What a sole-client gateway must do for this surface. */
  requirement: string;
  verdict: CapabilityVerdict;
  evidence: string;
}

/** Stock `codex app-server proxy` help first line (0.144.6 / 0.145.0). */
export const STOCK_PROXY_HELP_SUMMARY =
  "Proxy stdio bytes to the running app-server control socket";

/**
 * Capabilities a production gateway must own as the *sole* App Server client
 * while still exposing a complete interactive human surface.
 */
export const GATEWAY_CAPABILITIES: readonly GatewayCapability[] = [
  {
    id: "approvals",
    title: "Command / file-change approvals",
    requirement:
      "Present item/commandExecution/requestApproval and item/fileChange/requestApproval to a human and return a single authoritative response",
    verdict: "rejected",
    evidence:
      "Stock remote TUI does this as an App Server client; a gateway must reimplement that UI or embed the TUI. Stock proxy only forwards bytes — no request demux. S2a: first-response wins if two clients answer.",
  },
  {
    id: "elicitation",
    title: "MCP elicitation",
    requirement: "Handle mcpServer/elicitation/request (form/url) without auto-cancel racing a human",
    verdict: "rejected",
    evidence:
      "Headless tracer cancels elicitation (S1). A gateway that also injects mail cannot share that policy with a human TUI on the same connection without a full mediation UI.",
  },
  {
    id: "permissions",
    title: "Permissions grants",
    requirement: "Handle item/permissions/requestApproval with human-visible grant/deny",
    verdict: "rejected",
    evidence:
      "Same ownership as approvals: sole client must own the response. No observer role exists (S2a).",
  },
  {
    id: "user_input",
    title: "User input prompts",
    requirement: "Handle tool/requestUserInput (and item/tool/requestUserInput cleanup)",
    verdict: "rejected",
    evidence:
      "Requires interactive UI. Undocumented partial prompt surface is plan-forbidden for production.",
  },
  {
    id: "rendering",
    title: "Live turn rendering",
    requirement: "Human sees streamed items/turns for the owned thread",
    verdict: "rejected",
    evidence:
      "S2a proved stock remote TUI can render external turns — but only as a second App Server client. A sole-client gateway must itself be that renderer (full TUI/IDE clone), not a byte proxy in front of stock TUI.",
  },
  {
    id: "steering",
    title: "Active-turn steer",
    requirement: "Human and Agent Mail can append via turn/steer without dual clients",
    verdict: "rejected",
    evidence:
      "Feasible only if gateway merges human keystrokes and mail into one client connection. No stock component does that merge; proxy does not inspect JSON-RPC.",
  },
  {
    id: "interrupt",
    title: "Turn interrupt",
    requirement: "Human cancel maps to turn/interrupt on the sole connection",
    verdict: "rejected",
    evidence:
      "Requires gateway-owned input path. Stock TUI interrupt is client-local to its App Server session.",
  },
  {
    id: "reconnect",
    title: "Reconnect / ambiguous acceptance",
    requirement: "Survive client drop without orphaning server-request callbacks or double-delivering mail",
    verdict: "rejected",
    evidence:
      "Plan C5/ownership rules require explicit handoff, not implicit reconnect. A home-grown gateway would need its own durable session + request correlation — not supplied by stock proxy.",
  },
  {
    id: "failure",
    title: "Failure behavior",
    requirement: "App Server death / unknown methods fail closed; never silent fallback to exec-resume",
    verdict: "rejected",
    evidence:
      "S1 tracer already fails closed. A gateway adds a second failure domain (gateway process) without reducing App Server ownership risk unless it fully replaces the TUI — out of Phase-0 spike scope and not proven.",
  },
];

export interface GatewayFeasibilityReport {
  pinnedCodex: string;
  stockProxySummary: string;
  stockProxyIsArbitration: false;
  capabilities: readonly GatewayCapability[];
  verdict: "NO-GO";
  rationale: string;
}

export function gatewayFeasibilityReport(
  pinnedCodex = "0.144.6 (acceptance) / 0.145.0 (local)",
): GatewayFeasibilityReport {
  const rejected = GATEWAY_CAPABILITIES.filter((c) => c.verdict !== "proven");
  if (rejected.length !== GATEWAY_CAPABILITIES.length) {
    throw new Error("S2c spike expected every capability rejected until a complete gateway is proven");
  }
  return {
    pinnedCodex,
    stockProxySummary: STOCK_PROXY_HELP_SUMMARY,
    stockProxyIsArbitration: false,
    capabilities: GATEWAY_CAPABILITIES,
    verdict: "NO-GO",
    rationale:
      "A repository-owned gateway is only viable if it is the sole App Server client AND implements the complete interactive surface (approvals, elicitation, permissions, user input, rendering, steer, interrupt, reconnect). Stock `app-server proxy` is explicitly a byte pipe to the control socket — not arbitration. Building that complete client is a product, not a Phase-0 spike; reject gateway_owner for v1 and prefer exclusive headless ownership with explicit handoff (S1+S2b).",
  };
}
