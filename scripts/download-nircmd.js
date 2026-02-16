#!/usr/bin/env node
/**
 * Downloads nircmd.exe for Windows builds.
 *
 * nircmd is a small utility for Windows that allows sending keyboard input
 * and other system commands. Used for fast clipboard paste operations.
 *
 * Source: https://www.nirsoft.net/utils/nircmd.html
 * License: Free for non-commercial use
 */

const fs = require("fs");
const path = require("path");
const { downloadFile, extractZip, checkLocalCache, printCacheHint } = require("./lib/download-utils");

const NIRCMD_URL = "https://www.nirsoft.net/utils/nircmd-x64.zip";
const BIN_DIR = path.join(__dirname, "..", "resources", "bin");
const NIRCMD_PATH = path.join(BIN_DIR, "nircmd.exe");

async function main() {
  // Skip if not Windows and not building for all platforms
  if (process.platform !== "win32" && !process.argv.includes("--all")) {
    console.log("\nSkipping nircmd.exe download (Windows-only utility)\n");
    return;
  }

  console.log("\nDownloading nircmd.exe for Windows...\n");

  // Create bin directory
  fs.mkdirSync(BIN_DIR, { recursive: true });

  // Check if already exists
  if (fs.existsSync(NIRCMD_PATH)) {
    console.log("  nircmd.exe already exists, skipping\n");
    return;
  }

  const zipName = "nircmd-x64.zip";
  const zipPath = path.join(BIN_DIR, zipName);

  // Check local cache first, then fall back to network download
  const cachedPath = checkLocalCache(zipName);
  if (cachedPath) {
    console.log(`  Found in local cache: ${cachedPath}`);
    fs.copyFileSync(cachedPath, zipPath);
  } else {
    try {
      console.log(`  Downloading from ${NIRCMD_URL}`);
      await downloadFile(NIRCMD_URL, zipPath);
    } catch (error) {
      console.error(`  ✗ Failed to download nircmd.exe: ${error.message}\n`);
      printCacheHint(zipName, NIRCMD_URL);
      if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
      process.exit(1);
    }
  }

  try {
    console.log("  Extracting...");
    const extractDir = path.join(BIN_DIR, "temp-nircmd");
    fs.mkdirSync(extractDir, { recursive: true });
    await extractZip(zipPath, extractDir);

    // Copy nircmd.exe to bin directory
    const extractedPath = path.join(extractDir, "nircmd.exe");
    if (fs.existsSync(extractedPath)) {
      fs.copyFileSync(extractedPath, NIRCMD_PATH);
      const stats = fs.statSync(NIRCMD_PATH);
      console.log(`  ✓ nircmd.exe downloaded (${Math.round(stats.size / 1024)}KB)\n`);
    } else {
      console.error("  ✗ nircmd.exe not found in archive\n");
      process.exit(1);
    }

    // Cleanup
    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.unlinkSync(zipPath);
  } catch (error) {
    console.error(`  ✗ Failed to extract nircmd.exe: ${error.message}\n`);
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    process.exit(1);
  }
}

main().catch(console.error);
