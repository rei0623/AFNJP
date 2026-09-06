import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  copyFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "afnjp-generator-"));
  for (const p of [
    "scripts/generate-seo.mjs",
    "scripts/lib/reader-templates.mjs",
    "assets/reader-core.js",
    "package.json",
    "index.html",
    "posts.json",
    "posts-archive.json",
    "channels.json",
    "editorial.json",
  ]) {
    await mkdir(dirname(join(dir, p)), { recursive: true });
    await copyFile(join(root, p), join(dir, p));
  }
  return dir;
}
const run = (dir) =>
  spawnSync(process.execPath, ["scripts/generate-seo.mjs"], {
    cwd: dir,
    encoding: "utf8",
  });
async function snapshot(dir, prefix = "") {
  const result = {};
  for (const entry of await readdir(join(dir, prefix), {
    withFileTypes: true,
  })) {
    const p = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshot(dir, p));
    else result[p] = await readFile(join(dir, p), "utf8");
  }
  return result;
}
test("generation is idempotent and preserves marker exteriors, RSS GUIDs and own-site links", async () => {
  const dir = await fixture();
  try {
    const before = await readFile(join(dir, "index.html"), "utf8");
    const result = run(dir);
    assert.equal(result.status, 0, result.stderr);
    const exterior = (s) =>
      s.replace(
        /<!-- (POSTS|CHANNELS|ARCHIVE):START[\s\S]*?<!-- \1:END -->/g,
        "MARKER",
      );
    assert.equal(
      exterior(await readFile(join(dir, "index.html"), "utf8")),
      exterior(before),
    );
    const first = await snapshot(dir);
    assert.equal(run(dir).status, 0);
    assert.deepEqual(await snapshot(dir), first);
    const feed = await readFile(join(dir, "feed.xml"), "utf8");
    assert.match(
      feed,
      /<link>https:\/\/rei0623.github.io\/AFNJP\/posts\/\d+\.html<\/link>/,
    );
    assert.match(feed, /<guid isPermaLink="false">afnjp-\d+<\/guid>/);
    assert.doesNotMatch(feed, /<link>https:\/\/discord/);
    const home = await readFile(join(dir, "index.html"), "utf8");
    assert.equal(
      (home.match(/<noscript>/g) || []).length,
      (home.match(/<\/noscript>/g) || []).length,
    );
    assert.match(home, /google-site-verification/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
for (const kind of ["missing", "duplicate"])
  test(`invalid ${kind} marker rejects ALL output writes`, async () => {
    const dir = await fixture();
    try {
      const p = join(dir, "index.html");
      let html = await readFile(p, "utf8");
      html =
        kind === "missing"
          ? html.replace("<!-- POSTS:END -->", "")
          : html.replace(
              "<!-- POSTS:END -->",
              "<!-- POSTS:END --><!-- POSTS:END -->",
            );
      await writeFile(p, html);
      const before = await snapshot(dir);
      const result = run(dir);
      assert.notEqual(result.status, 0);
      assert.deepEqual(await snapshot(dir), before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
