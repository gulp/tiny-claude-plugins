/** Feature flags — resolved once at startup (F1). */

export type AdapterFlag = "headless-owner" | "gateway-owner-spike" | "exec-resume-spike";
export type OwnershipFlag = "exclusive-headless" | "explicit-handoff";

export interface FeatureFlags {
  enabled: boolean;
  adapter: AdapterFlag;
  ownership: OwnershipFlag;
  urgentSteer: boolean;
  deterministicCollapse: boolean;
  metricsHttp: boolean;
}

const DEFAULTS: FeatureFlags = {
  enabled: false,
  adapter: "headless-owner",
  ownership: "explicit-handoff",
  urgentSteer: false,
  deterministicCollapse: false,
  metricsHttp: false,
};

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  if (raw === "1" || raw.toLowerCase() === "true") return true;
  if (raw === "0" || raw.toLowerCase() === "false") return false;
  throw new Error(`boolean flag expected true/false/1/0, got ${JSON.stringify(raw)}`);
}

/** Resolve flags from env once. Does not read MAIL_WATCH_* (Claude monitor). */
export function resolveFeatureFlags(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): FeatureFlags {
  const adapterRaw = env.CODEX_INGRESS_ADAPTER ?? DEFAULTS.adapter;
  const ownershipRaw = env.CODEX_INGRESS_OWNERSHIP ?? DEFAULTS.ownership;
  const adapters: AdapterFlag[] = [
    "headless-owner",
    "gateway-owner-spike",
    "exec-resume-spike",
  ];
  const ownerships: OwnershipFlag[] = ["exclusive-headless", "explicit-handoff"];
  if (!adapters.includes(adapterRaw as AdapterFlag)) {
    throw new Error(`invalid CODEX_INGRESS_ADAPTER: ${adapterRaw}`);
  }
  if (!ownerships.includes(ownershipRaw as OwnershipFlag)) {
    throw new Error(`invalid CODEX_INGRESS_OWNERSHIP: ${ownershipRaw}`);
  }
  return {
    enabled: parseBool(env.CODEX_INGRESS_ENABLED, DEFAULTS.enabled),
    adapter: adapterRaw as AdapterFlag,
    ownership: ownershipRaw as OwnershipFlag,
    urgentSteer: parseBool(env.CODEX_INGRESS_URGENT_STEER, DEFAULTS.urgentSteer),
    deterministicCollapse: parseBool(
      env.CODEX_INGRESS_DETERMINISTIC_COLLAPSE,
      DEFAULTS.deterministicCollapse,
    ),
    metricsHttp: parseBool(env.CODEX_INGRESS_METRICS_HTTP, DEFAULTS.metricsHttp),
  };
}

export function flagsJson(flags: FeatureFlags): string {
  return JSON.stringify(
    {
      "codex_ingress.enabled": flags.enabled,
      "codex_ingress.adapter": flags.adapter,
      "codex_ingress.ownership": flags.ownership,
      "codex_ingress.urgent_steer": flags.urgentSteer,
      "codex_ingress.deterministic_collapse": flags.deterministicCollapse,
      "codex_ingress.metrics_http": flags.metricsHttp,
    },
    null,
    2,
  );
}
