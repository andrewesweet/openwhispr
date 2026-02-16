const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const REQUEST_TIMEOUT = 30000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;
const MAX_REDIRECTS = 5;

/**
 * Get the GitHub token from environment variables, if set.
 * Supports both GITHUB_TOKEN and GH_TOKEN (GitHub CLI convention).
 * Result is cached and logged on first access since env vars won't change
 * during a build script run.
 * @returns {string | null}
 */
let _cachedGitHubToken;
function getGitHubToken() {
  if (_cachedGitHubToken === undefined) {
    if (process.env.GITHUB_TOKEN) {
      _cachedGitHubToken = process.env.GITHUB_TOKEN;
      console.log("[auth] Using GITHUB_TOKEN for authenticated GitHub requests");
    } else if (process.env.GH_TOKEN) {
      _cachedGitHubToken = process.env.GH_TOKEN;
      console.log("[auth] Using GH_TOKEN for authenticated GitHub requests");
    } else {
      _cachedGitHubToken = null;
      console.log(
        "[auth] No GITHUB_TOKEN or GH_TOKEN found; GitHub requests will be unauthenticated"
      );
    }
  }
  return _cachedGitHubToken;
}

/**
 * Build request headers for a GitHub URL.
 * Always includes User-Agent; adds Authorization when a token is available
 * and the URL points to github.com.
 * @param {string} url - The target URL
 * @param {string} [accept] - Accept header value (e.g. "application/vnd.github+json")
 * @returns {object} Headers object
 */
function getGitHubHeaders(url, accept) {
  const headers = { "User-Agent": "OpenWhispr-Downloader" };

  if (accept) {
    headers.Accept = accept;
  }

  const token = getGitHubToken();
  if (token && url.includes("github.com")) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

/**
 * Fetch JSON from a URL with proper error handling.
 * @param {string} url - URL to fetch
 * @param {number} [redirectCount=0] - Current redirect count (internal use)
 * @returns {Promise<object>} - Parsed JSON response
 */
function fetchJson(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > MAX_REDIRECTS) {
      reject(new Error("Too many redirects"));
      return;
    }

    const options = {
      headers: getGitHubHeaders(url, "application/vnd.github+json"),
      timeout: REQUEST_TIMEOUT,
    };

    https
      .get(url, options, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const redirectUrl = res.headers.location;
          if (!redirectUrl) {
            reject(new Error("Redirect without location header"));
            return;
          }
          fetchJson(redirectUrl, redirectCount + 1)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Failed to parse JSON: ${e.message}`));
          }
        });
        res.on("error", reject);
      })
      .on("error", reject)
      .on("timeout", () => reject(new Error("Request timeout")));
  });
}

/**
 * Fetch the latest release from a GitHub repository.
 * @param {string} repo - Repository in "owner/repo" format
 * @param {object} options - Options
 * @param {string} [options.tagPrefix] - Only match releases with this tag prefix (e.g., "windows-key-listener-v")
 * @param {boolean} [options.includePrerelease=false] - Include prerelease versions
 * @returns {Promise<{tag: string, assets: Array<{name: string, url: string}>, url: string} | null>}
 */
async function fetchLatestRelease(repo, options = {}) {
  const { tagPrefix, includePrerelease = false } = options;

  try {
    // If no tag prefix, use the simple /latest endpoint
    if (!tagPrefix) {
      const url = `https://api.github.com/repos/${repo}/releases/latest`;
      const release = await fetchJson(url);
      return formatRelease(release);
    }

    // Otherwise, fetch all releases and filter by prefix
    const url = `https://api.github.com/repos/${repo}/releases?per_page=50`;
    const releases = await fetchJson(url);

    if (!Array.isArray(releases)) {
      return null;
    }

    // Find the latest release matching the prefix
    for (const release of releases) {
      if (release.draft) continue;
      if (!includePrerelease && release.prerelease) continue;
      if (release.tag_name && release.tag_name.startsWith(tagPrefix)) {
        return formatRelease(release);
      }
    }

    return null;
  } catch (error) {
    console.error(`  Failed to fetch latest release for ${repo}: ${error.message}`);
    return null;
  }
}

/**
 * Format a GitHub release response into a simplified object.
 * @param {object} release - GitHub release API response
 * @returns {{tag: string, assets: Array<{name: string, url: string}>, url: string}}
 */
function formatRelease(release) {
  return {
    tag: release.tag_name,
    url: release.html_url,
    assets: (release.assets || []).map((asset) => ({
      name: asset.name,
      url: asset.browser_download_url,
    })),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function downloadFile(url, dest, retryCount = 0) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let activeRequest = null;

    const cleanup = () => {
      if (activeRequest) {
        activeRequest.destroy();
        activeRequest = null;
      }
      file.close();
    };

    const request = (currentUrl, redirectCount = 0) => {
      if (redirectCount > MAX_REDIRECTS) {
        cleanup();
        reject(new Error("Too many redirects"));
        return;
      }

      const options = {
        headers: getGitHubHeaders(currentUrl, "application/octet-stream"),
        timeout: REQUEST_TIMEOUT,
      };

      activeRequest = https.get(currentUrl, options, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          const redirectUrl = response.headers.location;
          if (!redirectUrl) {
            cleanup();
            reject(new Error("Redirect without location header"));
            return;
          }
          request(redirectUrl, redirectCount + 1);
          return;
        }

        if (response.statusCode !== 200) {
          cleanup();
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        const total = parseInt(response.headers["content-length"], 10);
        let downloaded = 0;

        response.on("data", (chunk) => {
          downloaded += chunk.length;
          const pct = total ? Math.round((downloaded / total) * 100) : 0;
          process.stdout.write(`\r  Downloading: ${pct}%`);
        });

        response.on("error", (err) => {
          cleanup();
          reject(err);
        });

        response.pipe(file);
        file.on("finish", () => {
          file.close();
          console.log(" Done");
          resolve();
        });

        file.on("error", (err) => {
          cleanup();
          reject(err);
        });
      });

      activeRequest.on("error", (err) => {
        cleanup();
        reject(err);
      });

      activeRequest.setTimeout(REQUEST_TIMEOUT, () => {
        cleanup();
        reject(new Error("Connection timed out"));
      });
    };

    request(url);
  }).catch(async (error) => {
    const isTransient =
      error.message.includes("timed out") ||
      error.code === "ECONNRESET" ||
      error.code === "ETIMEDOUT";

    if (isTransient && retryCount < MAX_RETRIES) {
      console.log(`\n  Retry ${retryCount + 1}/${MAX_RETRIES}: ${error.message}`);
      await sleep(RETRY_DELAY);
      if (fs.existsSync(dest)) {
        fs.unlinkSync(dest);
      }
      return downloadFile(url, dest, retryCount + 1);
    }
    throw error;
  });
}

async function extractZip(zipPath, destDir) {
  if (process.platform === "win32") {
    // Use unzipper package on Windows for better path handling
    const unzipper = require("unzipper");
    await fs
      .createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: destDir }))
      .promise();
  } else {
    execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: "inherit" });
  }
}

function extractTarGz(tarPath, destDir) {
  execSync(`tar -xzf "${tarPath}" -C "${destDir}"`, { stdio: "inherit" });
}

async function extractArchive(archivePath, destDir) {
  if (archivePath.endsWith(".tar.gz") || archivePath.endsWith(".tgz")) {
    extractTarGz(archivePath, destDir);
  } else {
    await extractZip(archivePath, destDir);
  }
}

function findBinaryInDir(dir, binaryName, maxDepth = 5, currentDepth = 0) {
  if (currentDepth >= maxDepth) return null;

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const found = findBinaryInDir(fullPath, binaryName, maxDepth, currentDepth + 1);
      if (found) return found;
    } else if (entry.name === binaryName) {
      return fullPath;
    }
  }

  return null;
}

function parseArgs() {
  const args = process.argv;
  let targetPlatform = process.platform;
  let targetArch = process.arch;

  const platformIndex = args.indexOf("--platform");
  if (platformIndex !== -1 && args[platformIndex + 1]) {
    targetPlatform = args[platformIndex + 1];
  }

  const archIndex = args.indexOf("--arch");
  if (archIndex !== -1 && args[archIndex + 1]) {
    targetArch = args[archIndex + 1];
  }

  return {
    targetPlatform,
    targetArch,
    platformArch: `${targetPlatform}-${targetArch}`,
    isCurrent: args.includes("--current"),
    isAll: args.includes("--all"),
    isForce: args.includes("--force"),
    shouldCleanup:
      args.includes("--clean") ||
      process.env.CI === "true" ||
      process.env.GITHUB_ACTIONS === "true",
  };
}

function setExecutable(filePath) {
  if (process.platform !== "win32") {
    fs.chmodSync(filePath, 0o755);
  }
}

function cleanupFiles(binDir, prefix, keepPrefix) {
  const files = fs.readdirSync(binDir).filter((f) => f.startsWith(prefix));
  files.forEach((file) => {
    if (!file.startsWith(keepPrefix)) {
      const filePath = path.join(binDir, file);
      console.log(`Removing old binary: ${file}`);
      fs.unlinkSync(filePath);
    }
  });
}

/**
 * Get the local artifact cache directory.
 * Configurable via OPENWHISPR_DOWNLOAD_CACHE env var.
 * Defaults to ~/.cache/openwhispr/downloads/
 * @returns {string}
 */
function getCacheDir() {
  if (process.env.OPENWHISPR_DOWNLOAD_CACHE) {
    return process.env.OPENWHISPR_DOWNLOAD_CACHE;
  }
  return path.join(os.homedir(), ".cache", "openwhispr", "downloads");
}

/**
 * Check if a file exists in the local cache directory.
 * @param {string} filename - The filename to look for
 * @returns {string|null} Full path if found, null otherwise
 */
function checkLocalCache(filename) {
  const cacheDir = getCacheDir();
  const cachedPath = path.join(cacheDir, filename);
  if (fs.existsSync(cachedPath)) {
    return cachedPath;
  }
  return null;
}

/**
 * Check cache directory for files matching a regex pattern.
 * @param {RegExp} pattern - Pattern to match filenames
 * @returns {{name: string, path: string}|null} First match or null
 */
function checkLocalCacheByPattern(pattern) {
  const cacheDir = getCacheDir();
  if (!fs.existsSync(cacheDir)) return null;
  try {
    const files = fs.readdirSync(cacheDir);
    const match = files.find((f) => pattern.test(f));
    return match ? { name: match, path: path.join(cacheDir, match) } : null;
  } catch {
    return null;
  }
}

/**
 * Print a hint telling the user how to manually populate the cache.
 * @param {string} artifactName - The filename (or glob pattern) to download
 * @param {string} [url] - Optional direct download URL
 */
function printCacheHint(artifactName, url) {
  const cacheDir = getCacheDir();
  console.log(`\n  [cache] To resolve manually, download "${artifactName}"`);
  if (url) {
    console.log(`  [cache] from: ${url}`);
  }
  console.log(`  [cache] and place it in: ${cacheDir}`);
}

module.exports = {
  downloadFile,
  extractArchive,
  extractZip,
  fetchLatestRelease,
  findBinaryInDir,
  parseArgs,
  setExecutable,
  cleanupFiles,
  getCacheDir,
  checkLocalCache,
  checkLocalCacheByPattern,
  printCacheHint,
};
