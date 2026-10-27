"use strict";

// Runs the C++ backend for protocol tests. The executable comes from
// MSENTITY_VIEWER_BACKEND or the repository build (cmake --build build).

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { findBackendExecutable, PREFIX } = require("../../host");

const ROOT = path.resolve(__dirname, "../..");
const BACKEND = findBackendExecutable({ roots: [ROOT] });
const skip = BACKEND ? false : "msentity-viewer-backend is not built (cmake --build build)";

function parse(stdout) {
  return stdout.split(/\r?\n/).filter((line) => line.startsWith(PREFIX))
    .map((line) => JSON.parse(line.slice(PREFIX.length)));
}

/** Run one backend with `requests` on stdin and return every message. */
function runBackend(mode, file, requests, args = []) {
  const result = spawnSync(BACKEND, [mode, file, ...args], {
    input: requests.map((request) => JSON.stringify(request) + "\n").join(""),
    encoding: "utf8", timeout: 60000,
  });
  if (result.error) throw result.error;
  return parse(result.stdout);
}

/** A backend driven request by request: `await next("dataset-page")`. */
function interactive(mode, file, args = []) {
  const child = spawn(BACKEND, [mode, file, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  const queue = [];
  const waiters = [];
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const message of parse(lines.join("\n"))) {
      queue.push(message);
      waiters.splice(0).forEach((wake) => wake());
    }
  });
  const next = async (type) => {
    for (;;) {
      const index = queue.findIndex((message) => message.type === type || ["error", "edit-error"].includes(message.type));
      if (index >= 0) {
        const [message] = queue.splice(index, 1);
        if (message.type !== type) throw new Error(`unexpected ${message.type}: ${message.message}`);
        return message;
      }
      await new Promise((resolve, reject) => {
        waiters.push(resolve);
        setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 30000).unref();
      });
    }
  };
  const send = (request) => child.stdin.write(JSON.stringify(request) + "\n");
  const close = () => new Promise((resolve) => { child.on("exit", resolve); child.stdin.end(); });
  return { next, send, close };
}

function tempDir() {
  // Real path: the backend reports canonical paths as dataset ids.
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "msentity-viewer-test-")));
  return {
    file: (name, content) => {
      const target = path.join(directory, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (content !== undefined) fs.writeFileSync(target, content);
      return target;
    },
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

const ofType = (messages, type) => messages.filter((message) => message.type === type);

module.exports = { ROOT, BACKEND, skip, runBackend, interactive, tempDir, ofType };
