import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const children = [];

// Load .env.local so we can read MLX_SERVER_URL
async function loadLocalEnv() {
  try {
    const raw = await readFile(resolve(".env.local"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {}
}
await loadLocalEnv();

const mlxUrl = (process.env.MLX_SERVER_URL ?? "http://127.0.0.1:11234").replace(/\/$/, "");

function launch(command, args, label) {
  const child = spawn(command, args, { stdio: "inherit", env: process.env });
  child.on("exit", (code, signal) => {
    if (signal) return;
    if (code && code !== 0) console.error(`${label} stopped with exit code ${code}`);
  });
  children.push(child);
}

async function isMLXServerRunning() {
  try {
    const response = await fetch(`${mlxUrl}/v1/models`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
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

if (await isMLXServerRunning()) {
  console.log(`MLX server is already running on ${mlxUrl}`);
} else {
  console.log(`Starting MLX server on ${mlxUrl} …`);
  launch("mlx-serve", ["serve", "--max-resident-mem", "0"], "MLX server");
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

let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;

  // Unload all models from the MLX server before shutting down
  console.log("\nShutting down — unloading model from memory…");
  try {
    const modelsRes = await fetch(`${mlxUrl}/v1/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (modelsRes.ok) {
      const payload = await modelsRes.json();
      const models = Array.isArray(payload.data) ? payload.data : [];
      for (const model of models) {
        if (!model.loaded && model.state !== "ready") continue;
        try {
          const unloadRes = await fetch(`${mlxUrl}/v1/unload-model`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: model.id }),
            signal: AbortSignal.timeout(10_000),
          });
          if (unloadRes.ok) {
            console.log(`Unloaded model: ${model.id}`);
          } else {
            console.warn(`Could not unload ${model.id}: HTTP ${unloadRes.status}`);
          }
        } catch (err) {
          console.warn(`Could not unload ${model.id}: ${err.message ?? err}`);
        }
      }
    }
  } catch {
    // MLX server may already be gone — that's fine
  }

  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
