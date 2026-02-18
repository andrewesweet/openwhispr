#!/usr/bin/env node
/**
 * Downloads prebuilt Windows fast-paste binary from GitHub releases.
 * Used for terminal-aware clipboard paste on Windows.
 *
 * Usage:
 *   node scripts/download-windows-fast-paste.js [--force]
 *
 * Options:
 *   --force    Re-download even if binary already exists
 */

const fs = require("fs");
const path = require("path");
const {
  downloadWithCacheFallback,
  extractZip,
  fetchLatestRelease,
  setExecutable,
} = require("./lib/download-utils");

const REPO = "OpenWhispr/openwhispr";
const TAG_PREFIX = "windows-fast-paste-v";
const ZIP_NAME = "windows-fast-paste-win32-x64.zip";
const BINARY_NAME = "windows-fast-paste.exe";

const VERSION_OVERRIDE = process.env.WINDOWS_FAST_PASTE_VERSION || null;

const BIN_DIR = path.join(__dirname, "..", "resources", "bin");

async function main() {
  if (process.platform !== "win32") {
    console.log("[windows-fast-paste] Skipping download (not Windows)");
    return;
  }

  const forceDownload = process.argv.includes("--force");
  const outputPath = path.join(BIN_DIR, BINARY_NAME);

  if (fs.existsSync(outputPath) && !forceDownload) {
    console.log("[windows-fast-paste] Already exists (use --force to re-download)");
    console.log(`  ${outputPath}`);
    return;
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });

  if (VERSION_OVERRIDE) {
    console.log(`\n[windows-fast-paste] Using pinned version: ${VERSION_OVERRIDE}`);
  } else {
    console.log("\n[windows-fast-paste] Fetching latest release...");
  }
  const tagToFind = VERSION_OVERRIDE || TAG_PREFIX;
  const release = await fetchLatestRelease(REPO, { tagPrefix: tagToFind });
  const zipAsset = release?.assets?.find((a) => a.name === ZIP_NAME);

  if (release && zipAsset) {
    console.log(`\nDownloading Windows fast-paste (${release.tag})...\n`);
  }

  const result = await downloadWithCacheFallback({
    name: ZIP_NAME,
    url: zipAsset?.url || null,
    destDir: BIN_DIR,
  });
  if (!result) {
    console.log("[windows-fast-paste] Paste will use nircmd/PowerShell fallback");
    return;
  }
  const zipPath = result.path;

  try {
    const extractDir = path.join(BIN_DIR, "temp-windows-fast-paste");
    fs.mkdirSync(extractDir, { recursive: true });

    console.log("  Extracting...");
    await extractZip(zipPath, extractDir);

    const binaryPath = path.join(extractDir, BINARY_NAME);
    if (fs.existsSync(binaryPath)) {
      fs.copyFileSync(binaryPath, outputPath);
      setExecutable(outputPath);
      console.log(`  Extracted to: ${BINARY_NAME}`);
    } else {
      throw new Error(`Binary not found in archive: ${BINARY_NAME}`);
    }

    fs.rmSync(extractDir, { recursive: true, force: true });
    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
    }

    const stats = fs.statSync(outputPath);
    console.log(
      `\n[windows-fast-paste] Successfully installed (${Math.round(stats.size / 1024)}KB)`
    );
  } catch (error) {
    console.error(`\n[windows-fast-paste] Extraction failed: ${error.message}`);

    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
    }

    console.log("[windows-fast-paste] Paste will use nircmd/PowerShell fallback");
  }
}

main().catch((error) => {
  console.error("[windows-fast-paste] Unexpected error:", error);
  // Don't fail the build
});
