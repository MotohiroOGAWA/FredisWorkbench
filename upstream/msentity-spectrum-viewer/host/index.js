"use strict";

// Node.js host library of msentity-spectrum-viewer: runs the C++ backend,
// provides the optional RDKit features, and connects both to the UI
// components in ui/. It has no VS Code dependency; vscode/extension.js is one
// host built on it.

module.exports = {
  ...require("./backend"),
  ...require("./chemistry"),
  ...require("./session"),
};
