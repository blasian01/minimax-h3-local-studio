import { spawn } from "node:child_process";

const children = [];

function launch(command, args, label) {
  const child = spawn(command, args, { stdio: "inherit", env: process.env });
  child.on("exit", (code, signal) => {
    if (signal) return;
    if (code && code !== 0) console.error(`${label} stopped with exit code ${code}`);
  });
  children.push(child);
}

launch(process.execPath, ["server/index.mjs"], "Local generation API");
launch("npm", ["run", "dev:web"], "Web interface");

function stop() {
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 250);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
