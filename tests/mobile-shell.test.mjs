import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

test("root uses a static mobile-safe iframe shell", async () => {
  const [shell, worker] = await Promise.all([
    readFile(new URL("public/index.html", projectRoot), "utf8"),
    readFile(new URL("worker/index.ts", projectRoot), "utf8"),
  ]);

  assert.match(shell, /<meta name="viewport"[^>]*viewport-fit=cover/);
  assert.match(shell, /<iframe[\s\S]*src="\/flashcards\.html"/);
  assert.match(shell, /height:\s*100dvh/);
  assert.doesNotMatch(shell, /vinext|react|babel|tailwind/i);
  assert.match(worker, /url\.pathname === "\/"\) url\.pathname = "\/index\.html"/);
  assert.doesNotMatch(worker, /vinext\/server|app-router-entry/);
});
