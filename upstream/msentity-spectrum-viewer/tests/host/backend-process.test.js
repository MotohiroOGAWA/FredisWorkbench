"use strict";
// host/backend.js: starting the backend, messages, logs, and exit.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { BackendProcess, findBackendExecutable, executableName, platformId } = require("../../host");
const { ROOT, BACKEND, skip, tempDir } = require("../backend/helpers");

test("finds the repository build and names platforms", () => {
  assert.equal(findBackendExecutable({ roots: ["/nonexistent"], env: {} }), null);
  assert.equal(findBackendExecutable({ override: "/nonexistent/backend", roots: [], env: {} }), null);
  assert.equal(executableName("win32"), "msentity-viewer-backend.exe");
  assert.equal(platformId("linux", "x64"), "linux-x64");
  if (BACKEND) assert.equal(findBackendExecutable({ roots: [ROOT], env: {} }), BACKEND);
});

test("messages, logs, and exit of a backend process", { skip }, async () => {
  const tmp = tempDir();
  try {
    const file = tmp.file("a.tsv", "Name\tPeak\na\t100,1\n");
    const backend = new BackendProcess({ executable: BACKEND, mode: "dataset", file, pageSize: 5 });
    const messages = [];
    const exited = new Promise((resolve) => backend.on("exit", resolve));
    const page = new Promise((resolve) => backend.on("message", (message) => {
      messages.push(message);
      if (message.type === "dataset-page") resolve(message.value);
    }));
    assert.equal(backend.send({ type: "page" }), false);        // not started yet
    backend.start();
    assert.equal(backend.send({ type: "page" }), true);
    const value = await page;
    assert.equal(messages[0].type, "backend-ready");
    assert.equal(value.page_size, 5);
    assert.deepEqual(value.rows, [{ Name: "a" }]);
    backend.child.stdin.end();
    assert.equal(await exited, 0);
    assert.equal(backend.running, false);

    const missing = new BackendProcess({ executable: BACKEND, mode: "dataset", file: tmp.file("none.msp") });
    const error = new Promise((resolve) => missing.on("message", resolve));
    const code = new Promise((resolve) => missing.on("exit", resolve));
    missing.start();
    assert.equal((await error).title, "File not found");
    assert.equal(await code, 2);
  } finally {
    tmp.cleanup();
  }
});
