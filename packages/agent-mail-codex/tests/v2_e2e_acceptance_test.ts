/**
 * V2: run the ten plan acceptance scenarios three consecutive times.
 */
import { assertAllScenariosPass, runAllAcceptanceScenarios } from "../src/verify/acceptance.ts";

Deno.test("V2: end-to-end acceptance suite — three consecutive runs", async () => {
  for (let run = 1; run <= 3; run++) {
    const dir = await Deno.makeTempDir({ prefix: `amc-v2-run${run}-` });
    try {
      const results = await runAllAcceptanceScenarios(dir);
      assertAllScenariosPass(results);
    } finally {
      try {
        await Deno.remove(dir, { recursive: true });
      } catch {
        // ignore
      }
    }
  }
});
