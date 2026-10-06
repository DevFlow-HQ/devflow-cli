// The original probe demonstrated the missing initial-preparation owner at
// 4292ab9. Its positive successor is the maintained public-Interface conformance.
import { registerPreparationOwnership } from "../../tests/harness/preparation-conformance.js";
import type { RegisterConformanceCase } from "../../tests/harness/conformance.js";

const cases: {
  readonly name: string;
  readonly body: Parameters<RegisterConformanceCase>[1];
}[] = [];
registerPreparationOwnership((name, body) => cases.push({ name, body }));
for (const scenario of cases) {
  await scenario.body();
  console.log(JSON.stringify({ scenario: scenario.name, status: "passed" }));
}
