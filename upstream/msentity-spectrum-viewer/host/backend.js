"use strict";

// The C++ backend process (msentity-viewer-backend) and how to find it.

const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");

const PREFIX = "MSENTITY_JSON:";

/** Platform directory used for bundled executables: linux-x64, win32-x64, darwin-arm64, ... */
function platformId(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

function executableName(platform = process.platform) {
  return platform === "win32" ? "msentity-viewer-backend.exe" : "msentity-viewer-backend";
}

/**
 * Locate the backend executable. Order: `override` (a setting), the
 * MSENTITY_VIEWER_BACKEND environment variable, `<root>/bin/<platform>/` for each
 * root (a packaged extension), then `<root>/build/backend/` (a repository build).
 * Returns null when nothing exists.
 */
function findBackendExecutable({ roots = [], override = "", env = process.env } = {}) {
  const candidates = [];
  if (override) candidates.push(override);
  if (env.MSENTITY_VIEWER_BACKEND) candidates.push(env.MSENTITY_VIEWER_BACKEND);
  for (const root of roots) {
    candidates.push(path.join(root, "bin", platformId(), executableName()));
    candidates.push(path.join(root, "build", "backend", executableName()));
    candidates.push(path.join(root, "build", "backend", "Release", executableName()));
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

/**
 * One backend process serving a viewer.
 *
 *   const backend = new BackendProcess({ executable, mode: "dataset", file });
 *   backend.on("message", (message) => ...);   // every protocol message
 *   backend.start();
 *   backend.send({ type: "page", page: 0 });
 *   const reply = await backend.request({ type: "column-values", column: "SMILES" });
 *
 * Events: "message" (object), "log" (line, stream), "error" (Error), "exit" (code, signal).
 */
class BackendProcess extends EventEmitter {
  constructor({ executable, mode, file, pageSize, fileType, cwd, env } = {}) {
    super();
    this.options = { executable, mode, file, pageSize, fileType, cwd, env };
    this.child = null;
    this.pending = new Map();
    this.nextRequestId = 1;
  }

  start() {
    const { executable, mode, file, pageSize, fileType, cwd, env } = this.options;
    const args = [mode, file];
    if (pageSize) args.push("--page-size", String(pageSize));
    if (fileType) args.push("--file-type", fileType);
    const child = spawn(executable, args, {
      cwd: cwd || path.dirname(file), env: env || process.env, stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) this.handleLine(line);
    });
    let errorBuffer = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      errorBuffer += chunk;
      const lines = errorBuffer.split(/\r?\n/);
      errorBuffer = lines.pop() || "";
      for (const line of lines) if (line.trim()) this.emit("log", line, "stderr");
    });
    child.on("error", (error) => this.emit("error", error));
    child.on("exit", (code, signal) => {
      for (const { reject } of this.pending.values()) reject(new Error("The backend stopped."));
      this.pending.clear();
      this.emit("exit", code, signal);
    });
    return this;
  }

  handleLine(line) {
    if (!line.trim()) return;
    if (!line.startsWith(PREFIX)) {
      this.emit("log", line, "stdout");
      return;
    }
    let message;
    try {
      message = JSON.parse(line.slice(PREFIX.length));
    } catch (error) {
      this.emit("log", `protocol error: ${error.message} :: ${line}`, "protocol");
      return;
    }
    if (message.request_id != null && this.pending.has(message.request_id)) {
      const { resolve } = this.pending.get(message.request_id);
      this.pending.delete(message.request_id);
      resolve(message);
      return;
    }
    this.emit("message", message);
  }

  get running() {
    return Boolean(this.child && this.child.exitCode === null && this.child.stdin.writable);
  }

  /** Send a request; answers arrive as "message" events. Returns false when not running. */
  send(request) {
    if (!this.running) return false;
    this.child.stdin.write(`${JSON.stringify(request)}\n`);
    return true;
  }

  /** Send a request with a request_id and resolve with the reply carrying it. */
  request(request) {
    const requestId = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      if (!this.send({ ...request, request_id: requestId })) {
        this.pending.delete(requestId);
        reject(new Error("The backend is not running."));
      }
    });
  }

  stop() {
    if (this.child && this.child.exitCode === null) this.child.kill();
  }
}

module.exports = { BackendProcess, findBackendExecutable, platformId, executableName, PREFIX };
