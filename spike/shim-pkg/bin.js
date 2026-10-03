#!/usr/bin/env node
// Spike (#338) shim target: echoes argv/env, round-trips stdin, exits 42.
const mode = process.argv[2];
const line = (o) => process.stdout.write(JSON.stringify({ pid: process.pid, ...o }) + "\n");
if (mode === "argv") { line({ argv: process.argv.slice(3) }); process.exit(0); }
else if (mode === "env") { line({ env: { ...process.env } }); process.exit(0); }
else if (mode === "echo") {
  process.stderr.write("err-line\n");
  line({ argv: process.argv.slice(3) });
  process.stdin.on("data", (d) => process.stdout.write("echo:" + d));
  process.stdin.on("end", () => process.exit(42));
}
else if (mode === "hang") { line({}); setInterval(() => process.stdout.write("tick\n"), 100); }
else { process.stderr.write("unknown mode " + mode + "\n"); process.exit(2); }
