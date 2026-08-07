import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

// Include tracked files and every untracked file Git would publish. This keeps
// the audit effective before the first commit as well as afterward.
const tracked = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
)
  .split(/\r?\n/)
  .filter(Boolean);

const forbiddenPaths = [
  /(^|\/)\.env\.local$/,
  /(^|\/)(storage|uploads|generation-cache)(\/|$)/,
  /\.(mp4|mov|m4v|webm|avi|rgb|pcm|wav|aiff|flac)$/i,
  /\.(generated|response)\.json$/i,
];

const pathViolations = tracked.filter((file) => forbiddenPaths.some((pattern) => pattern.test(file)));
const contentViolations = [];
const contentPatterns = [
  { label: "personal home path", pattern: /\/Users\/[A-Za-z0-9._-]+\// },
  { label: "external-drive path", pattern: /\/Volumes\/[A-Za-z0-9._ -]+\// },
  { label: "embedded data URL", pattern: /data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=]{100,}/ },
];

for (const file of tracked) {
  let content;
  try { content = await readFile(file, "utf8"); }
  catch { continue; }
  for (const { label, pattern } of contentPatterns) {
    if (pattern.test(content)) contentViolations.push(`${file}: ${label}`);
  }
}

if (pathViolations.length || contentViolations.length) {
  console.error("Privacy check failed. Runtime/private data would enter source control.");
  for (const file of pathViolations) console.error(`  forbidden path: ${file}`);
  for (const issue of contentViolations) console.error(`  forbidden content: ${issue}`);
  process.exit(1);
}

console.log(`Privacy check passed: ${tracked.length} publishable source files contain no runtime media, local paths, or embedded reference images.`);
