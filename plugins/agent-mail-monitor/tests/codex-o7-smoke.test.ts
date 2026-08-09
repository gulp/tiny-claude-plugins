/**
 * O7 smoke: fresh install, reinstall, rollback, and stale-cache failure.
 *
 * Exercises the plugin manifest + control API without requiring a live Codex
 * session or systemd. Cache layout mirrors ~/.codex/plugins/cache/...
 */

import {
  detectVersionDrift,
  dispatchControl,
  PLUGIN_IDENTITY,
} from "../../../packages/agent-mail-codex/src/operator/control.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function writePlugin(root: string, version: string): Promise<void> {
  await Deno.mkdir(`${root}/.codex-plugin`, { recursive: true });
  await Deno.mkdir(`${root}/skills/agent-mail-codex`, { recursive: true });
  await Deno.mkdir(`${root}/scripts`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/.codex-plugin/plugin.json`,
    `${JSON.stringify({
      name: "agent-mail-monitor",
      version,
      description: "O7 smoke fixture",
      skills: "./skills/",
    }, null, 2)}\n`,
  );
  await Deno.writeTextFile(
    `${root}/skills/agent-mail-codex/SKILL.md`,
    "---\nname: agent-mail-codex\ndescription: fixture\n---\n# fixture\n",
  );
  await Deno.writeTextFile(`${root}/scripts/codex-control.ts`, "// fixture\n");
}

Deno.test("O7 smoke: fresh install manifest matches control expectedVersion", async () => {
  const source = new URL("../.codex-plugin/plugin.json", import.meta.url);
  const manifest = JSON.parse(await Deno.readTextFile(source)) as {
    name: string;
    version: string;
    skills: string;
  };
  assert(manifest.name === "agent-mail-monitor", "plugin name");
  assert(
    manifest.version === PLUGIN_IDENTITY.expectedVersion,
    `manifest ${manifest.version} != control ${PLUGIN_IDENTITY.expectedVersion}`,
  );
  assert(manifest.skills === "./skills/", "skills pointer");

  const skill = new URL("../skills/agent-mail-codex/SKILL.md", import.meta.url);
  const skillText = await Deno.readTextFile(skill);
  assert(skillText.includes("codex-control.ts"), "skill routes to control CLI");
  assert(skillText.includes("STALE_CACHE") || skillText.includes("stale cache"), "drift guidance");
});

Deno.test("O7 smoke: reinstall bumps cache key; rollback detected", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "o7-smoke-" });
  const cacheRoot = `${tmp}/.codex/plugins/cache/tiny-claude-plugins/agent-mail-monitor`;
  const v1 = "0.1.0+codex.20260728000000";
  const v2 = PLUGIN_IDENTITY.expectedVersion;

  await writePlugin(`${cacheRoot}/${v1}`, v1);
  await writePlugin(`${cacheRoot}/${v2}`, v2);

  // Fresh install lands on v2.
  const fresh = detectVersionDrift({
    observedPluginVersion: v2,
    observedPluginRoot: `${cacheRoot}/${v2}`,
  });
  assert(!fresh.drifted, fresh.detail);

  // Reinstall keeps expected version healthy.
  const reinstall = dispatchControl({
    action: "doctor",
    bindingId: "demo",
    agent: "CobaltJaguar",
    observedPluginVersion: v2,
    observedPluginRoot: `${cacheRoot}/${v2}`,
    unitActive: true,
    mailboxRootExists: true,
  });
  assert(reinstall.ok, reinstall.message);
  assert(
    reinstall.plugin.cacheKey.endsWith(`/${v2}`),
    reinstall.plugin.cacheKey,
  );

  // Rollback / stale cache still pointing at v1 fails loud.
  const rollback = detectVersionDrift({
    observedPluginVersion: v1,
    observedPluginRoot: `${cacheRoot}/${v1}`,
  });
  assert(rollback.drifted, "rollback must drift");
  assert(rollback.code === "stale_cache", rollback.code);

  const doctorStale = dispatchControl({
    action: "start",
    bindingId: "demo",
    agent: "CobaltJaguar",
    observedPluginVersion: v1,
    observedPluginRoot: `${cacheRoot}/${v1}`,
    unitActive: false,
  });
  assert(!doctorStale.ok, "start must refuse stale cache");
  assert(doctorStale.code === "stale_cache", doctorStale.code);

  await Deno.remove(tmp, { recursive: true });
});

Deno.test("O7 smoke: control script and skill exist beside tracer skill", async () => {
  const control = new URL("../scripts/codex-control.ts", import.meta.url);
  const tracerSkill = new URL("../skills/agent-mail-monitor/SKILL.md", import.meta.url);
  const prodSkill = new URL("../skills/agent-mail-codex/SKILL.md", import.meta.url);
  assert((await Deno.stat(control)).isFile, "codex-control.ts");
  assert((await Deno.stat(tracerSkill)).isFile, "tracer skill retained");
  assert((await Deno.stat(prodSkill)).isFile, "production skill added");
});
