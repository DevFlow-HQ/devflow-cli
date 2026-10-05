import assert from "node:assert/strict";
import { readSync, writeSync } from "node:fs";
import { DEFAULT_BUDGETS, readBundleAssets } from "../../src/bundle/bundle.js";
import { openCatalog } from "../../src/catalog/catalog.js";
import { observeCatalogAdmission } from "./catalog-admission.js";

// `overlap` parks once before repair admission; `hold` parks once more while the
// repair holds installation coordination, so the parent can probe the lock.
const [home, digest, mode] = process.argv.slice(2);
if (!home || !digest || (mode !== "overlap" && mode !== "hold")) {
  throw new Error("expected home, digest, and overlap/hold mode");
}

function signal(message: string): void {
  writeSync(1, `${message}\n`);
}

function park(message: string): void {
  signal(message);
  assert.equal(readSync(0, Buffer.alloc(1), 0, 1, null), 1);
}

// One overlap barrier per caller, taken once it has seen the tree incomplete and
// before it repairs.
let parked = false;
function parkOnce(): void {
  if (parked) return;
  parked = true;
  park("parked");
}

let reads = 0;
const catalog = openCatalog(home, {
  readAssets: (bytes) => {
    // Should repair ever stop requesting admission, its second asset read still
    // precedes extraction after the failed intactness check: the barrier holds,
    // so the scenario fails on the replaced tree rather than racing. Before #380
    // this was the only barrier the old path reached.
    reads += 1;
    if (reads === 2) parkOnce();
    return readBundleAssets(bytes, DEFAULT_BUDGETS);
  },
});
// Installed after opening, so only repair admission parks, never migration.
let held = false;
const restore = observeCatalogAdmission({
  before: parkOnce,
  admitted: () => {
    if (mode !== "hold" || held) return;
    held = true;
    park("holding");
  },
});
try {
  const root = catalog.assetRoot(digest);
  signal(`root ${JSON.stringify(root)}`);
  signal("repaired");
} finally {
  restore();
  catalog.close();
}
