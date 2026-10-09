import assert from "node:assert/strict";
import { cpSync, readFileSync } from "node:fs";
import test from "node:test";
import { z } from "zod";
import { createApplication } from "../../src/application/application.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import { runHeadless } from "../../src/headless/headless.js";
import { hostPlatform } from "../helpers/commandBundle.js";
import { makeTempDir } from "../helpers/tempDir.js";
import { createFakeProcess } from "../process/fake-adapter.js";
import { openFakeRunGroup } from "../run/store/fake-git-process.js";

const fixture = new URL(
  "../fixtures/previous-release-conversation/",
  import.meta.url,
);
const { runId } = z
  .object({ runId: z.string() })
  .parse(JSON.parse(readFileSync(new URL("expected.json", fixture), "utf8")));

test("m10-audit-legacy-turn-order: migrated transcript and run show JSON preserve predecessor bytes with the snapshot cursor", async () => {
  const home = makeTempDir("secant-legacy-json-");
  cpSync(fixture, home, { recursive: true });
  for (let pass = 0; pass < 2; pass++) {
    const catalog = openCatalog(home);
    const group = openFakeRunGroup(home, "/fixture/conversation", {
      isOwnerAlive: () => false,
    });
    const app = createApplication({
      catalog,
      runGroup: group,
      process: createFakeProcess({}),
      launchWorkspacePath: home,
      hostPlatform: hostPlatform(),
    });
    try {
      for (const [file, args] of [
        [
          "headless-transcript-shared.txt",
          ["run", "read", `${runId}/shared`, "--transcript", "--json"],
        ],
        [
          "headless-transcript-other.txt",
          ["run", "read", `${runId}/other`, "--transcript", "--json"],
        ],
        ["headless-show.txt", ["run", "show", runId, "--json"]],
      ] as const) {
        let stdout = "",
          stderr = "";
        const status = await runHeadless(app, args, {
          out: (text) => (stdout += text),
          err: (text) => (stderr += text),
          cwd: () => home,
        });
        assert.equal(status, 0, stderr);
        assert.equal(stderr, "");
        assert.equal(stdout, readFileSync(new URL(file, fixture), "utf8"));
      }
    } finally {
      await app.shutdown();
      group.close();
      catalog.close();
    }
  }
});
