"use strict";

// Release the VS Code extension in two steps.
//
//   npm run release:build   [-- patch|minor|major] [--skip-tests] [--dry-run]
//       Choose the next version (default: patch), commit "Release v<version>"
//       to main and push it (no tag), build the packages for Linux and Windows
//       with GitHub Actions (.github/workflows/release.yml), and download them
//       to dist/v<version>/. Nothing is published; run it again after a fix.
//
//   npm run release:publish [-- <version>] [--prerelease] [--dry-run]
//       Tag the built commit v<version> and publish the downloaded packages
//       (default: the newest unpublished build in dist/) as a GitHub Release.
//
//   npm run release         [-- patch|minor|major] [--prerelease] [--skip-tests] [--dry-run]
//       Both steps in a row.
//
// The current version is the highest tag v<major>.<minor>.<patch>; without
// any tag, the first release uses vscode/package.json as it is (1.0.0).
// Requires git, cmake, node, and an authenticated GitHub CLI (gh).

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");
const TARGETS = ["linux-x64", "win32-x64"];
const VARIANTS = ["", "-no-rdkit"];

const args = process.argv.slice(2);
const command = args[0];
const flags = new Set(args.slice(1).filter((a) => a.startsWith("--")));
const positional = args.slice(1).filter((a) => !a.startsWith("--"));
const dryRun = flags.has("--dry-run");

function fail(message) {
  console.error(`\nrelease: ${message}`);
  process.exit(1);
}
const usage = "usage: node scripts/release.js build [patch|minor|major] | publish [<version>] | all [patch|minor|major]\n" +
  "       options: --prerelease (publish, all), --skip-tests (build, all), --dry-run";
const allowed = {
  build: ["--skip-tests", "--dry-run"],
  publish: ["--prerelease", "--dry-run"],
  all: ["--skip-tests", "--prerelease", "--dry-run"],
};
if (!allowed[command] || positional.length > 1) fail(usage);
for (const flag of flags) if (!allowed[command].includes(flag)) fail(`option ${flag} does not apply to ${command}\n${usage}`);

/** Run a command; return its trimmed output (or exit on failure unless `allowFailure`). */
function run(program, programArgs, { capture = true, allowFailure = false } = {}) {
  const result = spawnSync(program, programArgs, {
    cwd: root, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) fail(`${program}: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    fail(`${program} ${programArgs.join(" ")} failed${capture ? `:\n${result.stderr || result.stdout}` : ""}`);
  }
  return capture ? (result.stdout || "").trim() : "";
}
const git = (...a) => run("git", a);
const step = (text) => console.log(`\n▶ ${text}`);
const sleep = (ms) => spawnSync(process.execPath, ["-e", `setTimeout(() => {}, ${ms})`]);

// ---- versions -----------------------------------------------------------------------------
const parse = (v) => v.split(".").map(Number);
const compare = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
const isVersion = (v) => /^\d+\.\d+\.\d+$/.test(v);
function bumped(version, kind) {
  const [major, minor, patch] = parse(version);
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}
const tagExists = (tag) => Boolean(git("tag", "--list", tag) || git("ls-remote", "--tags", "origin", `refs/tags/${tag}`));

function setVersion(version) {
  const changed = [];
  const write = (file, text) => { fs.writeFileSync(path.join(root, file), text); changed.push(file); };
  for (const file of ["vscode/package.json", "host/package.json", "vcpkg.json"]) {
    if (!fs.existsSync(path.join(root, file))) continue;
    const data = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    if (data.version === version) continue;
    data.version = version;
    write(file, `${JSON.stringify(data, null, 2)}\n`);
  }
  for (const file of ["vscode/package-lock.json", "host/package-lock.json"]) {
    if (!fs.existsSync(path.join(root, file))) continue;
    const data = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    if (data.version === version && data.packages?.[""]?.version === version) continue;
    data.version = version;
    if (data.packages?.[""]) data.packages[""].version = version;
    write(file, `${JSON.stringify(data, null, 2)}\n`);
  }
  const cmake = fs.readFileSync(path.join(root, "CMakeLists.txt"), "utf8");
  const updated = cmake.replace(/^(  VERSION )\d+\.\d+\.\d+$/m, `$1${version}`);
  if (updated !== cmake) write("CMakeLists.txt", updated);
  return changed;
}

const packageNames = (version) => TARGETS.flatMap((target) =>
  VARIANTS.map((variant) => `msentity-spectrum-viewer${variant}-${version}-${target}.vsix`));

// ---- repository -----------------------------------------------------------------------------
function repository({ requireClean }) {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (requireClean && branch !== "main") fail(`releases are built from main (current branch: ${branch})`);
  if (requireClean && git("status", "--porcelain")) fail("there are uncommitted changes; commit or stash them first");
  git("fetch", "--quiet", "--tags", "origin");
  if (requireClean && git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) {
    fail("main is not in sync with origin/main; pull or push first");
  }
  const submodules = git("submodule", "status");
  if (requireClean && /^[+\-U]/m.test(submodules)) fail(`submodules are not at their recorded commits:\n${submodules}`);
  const remote = git("remote", "get-url", "origin");
  const slug = (remote.match(/github\.com[:/](.+?)(\.git)?$/) || [])[1];
  if (!slug) fail(`origin is not a GitHub repository: ${remote}`);
  const tags = git("tag", "--list", "v*").split("\n").filter((t) => /^v\d+\.\d+\.\d+$/.test(t)).map((t) => t.slice(1));
  const latest = tags.sort((a, b) => compare(parse(a), parse(b))).pop() || null;
  return { slug, latest, submodules };
}

// ---- build ------------------------------------------------------------------------------------
function build(bump) {
  step("Checking the repository");
  const { slug, latest, submodules } = repository({ requireClean: true });
  const manifestVersion = JSON.parse(fs.readFileSync(path.join(root, "vscode/package.json"), "utf8")).version;
  const version = latest ? bumped(latest, bump) : manifestVersion;
  if (tagExists(`v${version}`)) fail(`tag v${version} already exists`);
  console.log(`  repository: ${slug}`);
  console.log(`  released:   ${latest ? `v${latest}` : "(nothing yet)"}`);
  console.log(`  building:   v${version}${latest ? ` (${bump})` : " (first release: version from vscode/package.json)"}`);
  console.log(`  submodules:\n${submodules.replace(/^/gm, "    ")}`);
  if (dryRun) {
    console.log(`\nDry run: would commit "Release v${version}" if needed, push main, build with GitHub Actions, and download to dist/v${version}/.`);
    return null;
  }
  run("gh", ["auth", "status"]);

  if (!flags.has("--skip-tests")) {
    step("Building the backend and running the tests");
    if (!fs.existsSync(path.join(root, "build", "CMakeCache.txt"))) {
      fail("build/ is not configured; run `cmake -S . -B build` once, or pass --skip-tests");
    }
    run("cmake", ["--build", "build"], { capture: false });
    run("node", ["scripts/run-tests.js"], { capture: false });
  }

  step(`Preparing v${version}`);
  const changed = setVersion(version);
  if (changed.length) {
    run("git", ["add", ...changed]);
    run("git", ["commit", "--quiet", "-m", `Release v${version}`]);
    run("git", ["push", "--quiet", "origin", "main"]);
    console.log(`  committed and pushed version ${version} (${changed.join(", ")})`);
  } else {
    console.log(`  the manifests already have version ${version}`);
  }
  const commit = git("rev-parse", "HEAD");

  step("Building on GitHub Actions (Linux and Windows)");
  const started = new Date(Date.now() - 60_000).toISOString();
  run("gh", ["workflow", "run", "release.yml", "--repo", slug, "--ref", "main", "-f", `version=${version}`]);
  let runId = "";
  for (let attempt = 0; attempt < 30 && !runId; attempt++) {
    sleep(attempt ? 5000 : 3000);
    runId = run("gh", ["run", "list", "--repo", slug, "--workflow", "release.yml", "--event", "workflow_dispatch",
      "--limit", "20", "--json", "databaseId,headSha,createdAt",
      "--jq", `[.[] | select(.headSha == "${commit}" and .createdAt >= "${started}")][0].databaseId // empty`],
    { allowFailure: true });
  }
  if (!runId) fail(`the workflow did not start; see https://github.com/${slug}/actions`);
  console.log(`  https://github.com/${slug}/actions/runs/${runId}`);
  run("gh", ["run", "watch", runId, "--repo", slug, "--exit-status", "--interval", "30"], { capture: false });

  step(`Downloading the packages to dist/v${version}/`);
  const out = path.join(distDir, `v${version}`);
  fs.rmSync(out, { recursive: true, force: true });
  const download = path.join(out, "download");
  run("gh", ["run", "download", runId, "--repo", slug, "--dir", download]);
  for (const name of packageNames(version)) {
    const found = fs.readdirSync(download).map((d) => path.join(download, d, name)).find((f) => fs.existsSync(f));
    if (!found) fail(`the build did not produce ${name}`);
    fs.renameSync(found, path.join(out, name));
  }
  fs.rmSync(download, { recursive: true, force: true });
  fs.writeFileSync(path.join(out, "build.json"), `${JSON.stringify({ version, commit, run: Number(runId) }, null, 2)}\n`);
  for (const name of packageNames(version)) {
    console.log(`  ${path.relative(root, path.join(out, name))}  (${(fs.statSync(path.join(out, name)).size / 1e6).toFixed(1)} MB)`);
  }
  console.log(`\nTry them with: code --install-extension dist/v${version}/<file>.vsix --force`);
  console.log(`Publish with:  npm run release:publish`);
  return version;
}

// ---- publish ----------------------------------------------------------------------------------
function publish(requested) {
  step("Checking the build");
  const { slug } = repository({ requireClean: false });
  let version = requested;
  if (version && !isVersion(version)) fail(`not a version: ${version}`);
  if (!version) {
    const builds = (fs.existsSync(distDir) ? fs.readdirSync(distDir) : [])
      .filter((d) => /^v\d+\.\d+\.\d+$/.test(d) && fs.existsSync(path.join(distDir, d, "build.json")))
      .map((d) => d.slice(1)).filter((v) => !tagExists(`v${v}`))
      .sort((a, b) => compare(parse(a), parse(b)));
    version = builds.pop();
    if (!version) fail("no unpublished build in dist/; run `npm run release:build` first");
  }
  const tag = `v${version}`;
  const out = path.join(distDir, tag);
  const infoFile = path.join(out, "build.json");
  if (!fs.existsSync(infoFile)) fail(`dist/${tag}/build.json not found; run \`npm run release:build\` first`);
  const info = JSON.parse(fs.readFileSync(infoFile, "utf8"));
  if (tagExists(tag)) fail(`tag ${tag} already exists`);
  for (const name of packageNames(version)) {
    if (!fs.existsSync(path.join(out, name))) fail(`dist/${tag}/${name} is missing; build again`);
  }
  if (spawnSync("git", ["merge-base", "--is-ancestor", info.commit, "origin/main"], { cwd: root }).status !== 0) {
    fail(`the built commit ${info.commit.slice(0, 7)} is not on origin/main`);
  }
  console.log(`  repository:  ${slug}`);
  console.log(`  release:     ${tag} (commit ${info.commit.slice(0, 7)}, build https://github.com/${slug}/actions/runs/${info.run})`);
  console.log(`  pre-release: ${flags.has("--prerelease") ? "yes" : "no"}`);
  console.log(`  packages:    ${packageNames(version).length} files, plus the same under fixed names`);
  if (dryRun) {
    console.log(`\nDry run: would tag ${info.commit.slice(0, 7)} as ${tag}, push the tag, and create the GitHub Release.`);
    return;
  }
  run("gh", ["auth", "status"]);

  step(`Publishing ${tag}`);
  const files = [];
  for (const name of packageNames(version)) {
    files.push(path.join(out, name));
    const fixed = path.join(out, name.replace(`-${version}-`, "-"));   // for releases/latest/download
    fs.copyFileSync(path.join(out, name), fixed);
    files.push(fixed);
  }
  const notes = path.join(out, "notes.md");
  fs.writeFileSync(notes, fs.readFileSync(path.join(root, ".github", "release-notes.md"), "utf8")
    .replace(/@VERSION@/g, version).replace(/@TAG@/g, tag));
  run("git", ["tag", "-a", tag, info.commit, "-m", `msentity Spectrum Viewer ${tag}`]);
  run("git", ["push", "--quiet", "origin", tag]);
  console.log(`  pushed tag ${tag}`);
  run("gh", ["release", "create", tag, ...files, "--repo", slug, "--verify-tag",
    "--title", `msentity Spectrum Viewer ${tag}`, "--notes-file", notes, "--generate-notes",
    ...(flags.has("--prerelease") ? ["--prerelease"] : [])]);
  const url = run("gh", ["release", "view", tag, "--repo", slug, "--json", "url", "--jq", ".url"]);
  console.log(`\nReleased ${tag}: ${url}`);
}

// ---- main ------------------------------------------------------------------------------------
if (command === "build") {
  const bump = positional[0] || "patch";
  if (!["patch", "minor", "major"].includes(bump)) fail(usage);
  build(bump);
} else if (command === "publish") {
  publish(positional[0]);
} else {
  const bump = positional[0] || "patch";
  if (!["patch", "minor", "major"].includes(bump)) fail(usage);
  const version = build(bump);
  if (version) publish(version);
}
