// Round trip: write lines to a child's stdin, read them back on stdout, see stderr, get the exit code.
import { spawnContained } from "./contained-spawn";

const child = await spawnContained(
  `bun -e "process.stderr.write('err-line\\n'); for await (const c of process.stdin) process.stdout.write('echo:' + c); process.exit(7)"`,
);
console.log("pid", child.pid, "inJob", child.inJob());

let out = "", err = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (err += d));

// The event loop must stay live while the child runs.
let ticks = 0;
const t = setInterval(() => ticks++, 10);

child.stdin.write("one\n");
await Bun.sleep(300);
child.stdin.write("two\n");
child.stdin.end();

const code = await child.exited;
await Bun.sleep(100);
clearInterval(t);
console.log(JSON.stringify({ code, out, err, ticks }));
