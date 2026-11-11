// Version plumbing shared by the website and the Android app.
//
// The website version must be stable for a given deployment but change whenever
// the site changes — otherwise every serverless cold start would look like a new
// release and the app would prompt its users for no reason. On Vercel the commit
// SHA provides that; on a plain server we hash the public assets instead.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const REPO = process.env.GITHUB_REPO || "alsphalt/bigbrother";
const CACHE_MS = 5 * 60 * 1000;

const cache = { at: 0, value: null, loaded: false };

export function websiteVersion(publicDir) {
  if (process.env.APP_VERSION) return process.env.APP_VERSION;
  // Each deployment gets a stable identity, and a new commit gets a new one.
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 12);
  if (process.env.VERCEL_DEPLOYMENT_ID) return process.env.VERCEL_DEPLOYMENT_ID.slice(-12);
  const hash = crypto.createHash("sha1");
  let bytes = 0;
  for (const file of ["index.html", "app.js", "style.css"]) {
    try {
      const content = fs.readFileSync(path.join(publicDir, file));
      bytes += content.length;
      hash.update(content);
    } catch {
      /* a missing asset simply does not contribute */
    }
  }
  if (!bytes) {
    console.warn(
      "WARNING: cannot read public assets to stamp the website version. Set APP_VERSION so the Android app can detect updates."
    );
    return "unknown";
  }
  return hash.digest("hex").slice(0, 12);
}

function githubHeaders() {
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "darknote-cloud",
    "x-github-api-version": "2022-11-28"
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function readVersionAsset(url) {
  try {
    const res = await fetch(url, { headers: { "user-agent": "darknote-cloud" } });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      versionCode: Number(data.versionCode) || 0,
      versionName: String(data.versionName || "")
    };
  } catch {
    return null;
  }
}

// Latest published GitHub release that carries an APK. Cached briefly so a busy
// site does not burn the unauthenticated GitHub quota.
export async function latestRelease({ force = false } = {}) {
  if (!force && cache.loaded && Date.now() - cache.at < CACHE_MS) return cache.value;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=10`, {
      headers: githubHeaders()
    });
    if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
    const releases = await res.json();
    const release = releases.find((r) => !r.draft && !r.prerelease && (r.assets || []).some((a) => a.name.endsWith(".apk")));
    if (!release) {
      cache.at = Date.now();
      cache.value = null;
      cache.loaded = true;
      return null;
    }
    const assets = release.assets || [];
    const apk = assets.find((a) => a.name.endsWith("-release.apk")) || assets.find((a) => a.name.endsWith(".apk"));
    const meta = assets.find((a) => a.name === "app-version.json");
    const parsed = meta ? await readVersionAsset(meta.browser_download_url) : null;
    const tag = String(release.tag_name || "").replace(/^v/, "");
    const value = {
      versionName: parsed?.versionName || tag || "1.0.0",
      versionCode: parsed?.versionCode || 0,
      sizeBytes: apk.size,
      publishedAt: release.published_at,
      assetName: apk.name,
      assetUrl: apk.browser_download_url,
      releaseUrl: release.html_url
    };
    cache.at = Date.now();
    cache.value = value;
    cache.loaded = true;
    return value;
  } catch (e) {
    // Keep the last good answer and retry on the next request.
    console.error("app version lookup failed:", e.message);
    return cache.value;
  }
}
