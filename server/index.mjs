import { createHash, randomInt } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

function postJson(urlStr, dataObj, timeoutMs = 3_600_000) {
  return new Promise((resolvePromise, reject) => {
    const url = new URL(urlStr);
    const body = Buffer.from(JSON.stringify(dataObj), "utf8");
    const req = httpRequest(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolvePromise({ ok: Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300), status: res.statusCode ?? 500, text });
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs / 1000}s`));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function loadLocalEnv() {
  try {
    const raw = await readFile(join(root, ".env.local"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {}
}

await loadLocalEnv();

const port = Number(process.env.STUDIO_API_PORT ?? 8787);
const mlxUrl = (process.env.MLX_SERVER_URL ?? "http://127.0.0.1:11234").replace(/\/$/, "");
let generationDir = resolve(process.env.GENERATION_DIR ?? join(root, "storage", "generations"));
await mkdir(generationDir, { recursive: true });

let generationActive = false;

const allowedResolutions = new Set([
  "480x864",
  "576x1024",
  "640x480",
  "704x1280",
  "864x480",
  "1024x576",
  "1280x704",
]);

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "http://localhost:3000",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    ...extra,
  };
}

function json(res, status, body) {
  res.writeHead(status, corsHeaders({ "Content-Type": "application/json; charset=utf-8" }));
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 22 * 1024 * 1024) throw new Error("Request is larger than 22 MB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-1800)}`));
    });
  });
}

function safeBase64(dataUrl) {
  if (!dataUrl) return null;
  const match = String(dataUrl).match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) throw new Error("Reference image must be a PNG, JPEG, or WebP file");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length || bytes.length > 15 * 1024 * 1024) throw new Error("Reference image must be between 1 byte and 15 MB");
  return bytes;
}

async function listGenerations() {
  const names = (await readdir(generationDir)).filter((name) => name.endsWith(".json"));
  const rows = await Promise.all(names.map(async (name) => {
    try { return JSON.parse(await readFile(join(generationDir, name), "utf8")); }
    catch { return null; }
  }));
  return rows.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function serveFile(res, filename) {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "");
  if (safeName !== filename) return json(res, 400, { error: "Invalid media path" });
  const filePath = join(generationDir, safeName);
  try {
    const info = await stat(filePath);
    const type = extname(filePath) === ".mp4" ? "video/mp4" : "image/jpeg";
    res.writeHead(200, corsHeaders({ "Content-Type": type, "Content-Length": info.size, "Cache-Control": "public, max-age=31536000, immutable" }));
    createReadStream(filePath).pipe(res);
  } catch {
    json(res, 404, { error: "Media not found" });
  }
}

async function modelStatus() {
  try {
    const response = await fetch(`${mlxUrl}/v1/models`, { signal: AbortSignal.timeout(3000) });
    const payload = await response.json();
    const models = Array.isArray(payload.data) ? payload.data : [];
    const model = models.find((item) => item.capabilities?.includes("video")) ?? models[0] ?? null;
    const loaded = Boolean(model?.loaded && model?.state === "ready");
    return {
      serverOnline: response.ok,
      connected: response.ok && loaded,
      loaded,
      model: model?.id ?? null,
      modelState: model?.state ?? "unavailable",
      bytesResident: Number(model?.bytes_resident ?? 0),
      cache: "fast-step + disk",
    };
  } catch {
    return {
      serverOnline: false,
      connected: false,
      loaded: false,
      model: null,
      modelState: "offline",
      bytesResident: 0,
      cache: "fast-step + disk",
    };
  }
}

async function setModelLoaded(shouldLoad) {
  if (generationActive) throw new Error("Wait for the current generation to finish before changing model memory");
  const status = await modelStatus();
  if (!status.serverOnline) throw new Error("The local MLX server is not running");
  if (!status.model) throw new Error("No video model is registered with the local MLX server");
  if (status.loaded === shouldLoad) return status;

  const response = await fetch(`${mlxUrl}/v1/${shouldLoad ? "load" : "unload"}-model`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: status.model }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    throw new Error(payload.error?.message ?? payload.message ?? `Could not ${shouldLoad ? "load" : "unload"} the model`);
  }
  return modelStatus();
}

async function generate(body) {
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) throw new Error("Enter a prompt before generating");
  if (prompt.length > 4000) throw new Error("Prompt must be under 4,000 characters");

  const requestedResolution = `${Number(body.width)}x${Number(body.height)}`;
  const resolution = allowedResolutions.has(requestedResolution) ? requestedResolution : "864x480";
  const [width, height] = resolution.split("x").map(Number);
  const duration = [5, 10].includes(Number(body.duration)) ? Number(body.duration) : 5;
  const requestedFrames = duration * 24;
  const steps = 30;
  const seed = Number.isSafeInteger(Number(body.seed)) ? Math.max(0, Number(body.seed)) : randomInt(0, 10_000_000);
  const referenceBytes = safeBase64(body.referenceImage);
  const referenceHash = referenceBytes ? createHash("sha256").update(referenceBytes).digest("hex") : null;
  const signature = JSON.stringify({ prompt, width, height, duration, steps, seed, fast: true, referenceHash });
  const id = createHash("sha256").update(signature).digest("hex").slice(0, 16);
  const outputName = `h3-${id}.mp4`;
  const posterName = `h3-${id}.jpg`;
  const metadataName = `h3-${id}.json`;
  const outputPath = join(generationDir, outputName);
  const metadataPath = join(generationDir, metadataName);

  if (body.useCache !== false) {
    try {
      await stat(outputPath);
      const cached = JSON.parse(await readFile(metadataPath, "utf8"));
      return { ...cached, cached: true };
    } catch {}
  }

  const workDir = await mkdtemp(join(generationDir, ".h3-work-"));
  try {
    let firstFrameImage;
    if (referenceBytes) {
      const inputPath = join(workDir, "reference.input");
      const preparedPath = join(workDir, "reference.jpg");
      await writeFile(inputPath, referenceBytes);
      await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y", "-i", inputPath,
        "-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`,
        "-frames:v", "1", preparedPath,
      ]);
      firstFrameImage = (await readFile(preparedPath)).toString("base64");
    }

    const status = await modelStatus();
    const requestBody = {
      ...(status.model ? { model: status.model } : {}),
      prompt,
      width,
      height,
      num_frames: requestedFrames,
      steps,
      seed,
      fast: true,
      ...(firstFrameImage ? { first_frame_image: firstFrameImage } : {}),
    };

    const response = await postJson(`${mlxUrl}/v1/video/generations`, requestBody, 3_600_000);
    let payload;
    try { payload = JSON.parse(response.text); }
    catch { throw new Error(`MiniMax returned an unreadable response (${response.status})`); }
    if (!response.ok || payload.error) throw new Error(payload.error?.message ?? payload.message ?? `MiniMax returned HTTP ${response.status}`);
    if (!payload.data) throw new Error("MiniMax returned no video data");

    const rgbPath = join(workDir, "video.rgb");
    const pcmPath = join(workDir, "audio.pcm");
    await writeFile(rgbPath, Buffer.from(payload.data, "base64"));
    const hasAudio = Boolean(payload.audio_data);
    if (hasAudio) await writeFile(pcmPath, Buffer.from(payload.audio_data, "base64"));

    const actualWidth = Number(payload.width ?? width);
    const actualHeight = Number(payload.height ?? height);
    const fps = Number(payload.fps ?? 24);
    const ffmpegArgs = [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", `${actualWidth}x${actualHeight}`,
      "-framerate", String(fps), "-i", rgbPath,
    ];
    if (hasAudio) {
      ffmpegArgs.push("-f", "s16le", "-ar", String(payload.audio_sample_rate ?? 32000), "-ac", String(payload.audio_channels ?? 2), "-i", pcmPath);
    }
    ffmpegArgs.push(
      "-t", String(duration), "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
      ...(hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : []),
      "-movflags", "+faststart", outputPath,
    );
    await run("ffmpeg", ffmpegArgs);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", "1", "-i", outputPath, "-frames:v", "1", "-q:v", "3", join(generationDir, posterName)]);

    const generation = {
      id,
      prompt,
      createdAt: new Date().toISOString(),
      duration,
      width: actualWidth,
      height: actualHeight,
      seed,
      referenceUsed: Boolean(referenceBytes),
      cached: false,
      url: `/media/${outputName}`,
      thumbnailUrl: `/media/${posterName}`,
    };
    await writeFile(metadataPath, `${JSON.stringify(generation, null, 2)}\n`);
    return generation;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      return res.end();
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, 200, await modelStatus());
    }
    if (req.method === "POST" && url.pathname === "/api/model/load") {
      return json(res, 200, await setModelLoaded(true));
    }
    if (req.method === "POST" && url.pathname === "/api/model/unload") {
      return json(res, 200, await setModelLoaded(false));
    }
    if (req.method === "GET" && url.pathname === "/api/generations") {
      return json(res, 200, { generations: await listGenerations() });
    }
    if (req.method === "GET" && url.pathname === "/api/save-path") {
      return json(res, 200, { savePath: generationDir });
    }
    if (req.method === "POST" && url.pathname === "/api/save-path") {
      const body = await readJson(req);
      const newPath = String(body.savePath ?? "").trim();
      if (!newPath) return json(res, 400, { error: "A save path is required" });
      try {
        const resolved = resolve(newPath);
        await mkdir(resolved, { recursive: true });
        // Verify the directory is writable by trying to stat it
        await stat(resolved);
        generationDir = resolved;
        return json(res, 200, { savePath: generationDir });
      } catch (err) {
        return json(res, 400, { error: `Cannot use that directory: ${err instanceof Error ? err.message : err}` });
      }
    }
    if (req.method === "GET" && url.pathname.startsWith("/media/")) {
      return serveFile(res, decodeURIComponent(url.pathname.slice(7)));
    }
    if (req.method === "POST" && url.pathname === "/api/generate") {
      if (generationActive) return json(res, 409, { error: "A generation is already running. Wait for it to finish before starting another." });
      generationActive = true;
      try {
        const generation = await generate(await readJson(req));
        return json(res, 200, { generation });
      } finally {
        generationActive = false;
      }
    }
    json(res, 404, { error: "Not found" });
  } catch (error) {
    generationActive = false;
    console.error(error);
    json(res, 500, { error: error instanceof Error ? error.message : "Unexpected server error" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`MiniMax Studio API: http://127.0.0.1:${port}`);
  console.log(`Generation archive: ${generationDir}`);
});
