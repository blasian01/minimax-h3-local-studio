import { spawn } from "node:child_process";
import { resolve } from "node:path";

const children = [];

function launch(command, args, label) {
  const child = spawn(command, args, { stdio: "inherit", env: process.env });
  child.on("exit", (code, signal) => {
    if (signal) return;
    if (code && code !== 0) console.error(`${label} stopped with exit code ${code}`);
  });
  children.push(child);
}

async function isStudioApiRunning() {
  try {
    const response = await fetch("http://127.0.0.1:8787/api/health", {
      signal: AbortSignal.timeout(1500),
    });
    const health = await response.json();
    return response.ok && health.resolution === "864x480";
  } catch {
    return false;
  }
}

async function isStudioWebRunning() {
  try {
    const response = await fetch("http://localhost:3000/", {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok && (await response.text()).includes("MiniMax Studio");
  } catch {
    return false;
  }
}

if (await isStudioApiRunning()) {
  console.log("Local generation API is already running on http://127.0.0.1:8787");
} else {
  launch(process.execPath, ["server/index.mjs"], "Local generation API");
}

if (await isStudioWebRunning()) {
  console.log("Web interface is already running on http://localhost:3000");
} else {
  launch(
    process.execPath,
    [resolve("node_modules/vinext/dist/cli.js"), "dev"],
    "Web interface",
  );
}

if (children.length === 0) {
  console.log("MiniMax Studio is ready. No duplicate processes were started.");
}

function stop() {
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 250);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
