// Mirrors scripts/build.ts's Bun.build compile shape for the windows-x64 target.
const result = await Bun.build({
  entrypoints: ["./spike/main.ts"],
  conditions: ["bun", "node"],
  format: "esm",
  splitting: true,
  compile: { target: "bun-windows-x64", outfile: "dist/spike.exe" },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("bun build --compile failed");
}
console.log("Built dist/spike.exe (bun-windows-x64).");
