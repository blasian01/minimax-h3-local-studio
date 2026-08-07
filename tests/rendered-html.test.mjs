import assert from "node:assert/strict";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: handler } = await import(workerUrl.href);
  return handler(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
  );
}

test("renders the MiniMax local studio", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /MiniMax H3 Local Studio/i);
  assert.match(html, /MiniMax Studio/i);
  assert.match(html, /Direct the next shot/i);
  assert.match(html, /864 × 480/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("ships a public-safe local configuration example", async () => {
  const [example, ignored] = await Promise.all([
    import("node:fs/promises").then(({ readFile }) => readFile(new URL("../.env.example", import.meta.url), "utf8")),
    import("node:fs/promises").then(({ readFile }) => readFile(new URL("../.gitignore", import.meta.url), "utf8")),
  ]);
  assert.match(example, /MLX_SERVER_URL=http:\/\/127\.0\.0\.1:11234/);
  assert.match(example, /GENERATION_DIR=.\/storage\/generations/);
  assert.match(ignored, /\.env\*/);
  assert.doesNotMatch(example, /\/Users\//);
  assert.ok(root);
});
