"use strict";

// Run the test suite: every tests/**/*.test.js file with `node --test`.
//
//   node scripts/run-tests.js [extra node --test options]
//
// Listing the files explicitly works with every Node.js version (Node 20
// expands a directory argument, Node 22 treats arguments as file patterns)
// and needs no shell globbing (Windows).

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const testsDir = path.join(root, "tests");

function collect(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) return collect(full);
      return entry.name.endsWith(".test.js") ? [full] : [];
    });
}

const files = collect(testsDir);
if (!files.length) {
  console.error("no tests found in tests/");
  process.exit(1);
}
const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files],
  { cwd: root, stdio: "inherit" });
process.exit(result.status ?? 1);
