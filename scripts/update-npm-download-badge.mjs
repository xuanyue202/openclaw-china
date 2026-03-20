import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCOPE_PREFIX = "@openclaw-china/";
const BADGE_DIR = ".github/badges";
const BADGE_FILE = "npm-downloads-18m.json";
const BADGE_SVG_FILE = "npm-downloads-18m.svg";
const SUMMARY_FILE = "npm-downloads-18m-summary.json";
const REQUEST_TIMEOUT_MS = 15_000;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

async function main() {
  const packageNames = await discoverScopedPackages();
  const endDate = formatDateUTC(new Date());
  const startDate = formatDateUTC(monthsAgoUtc(new Date(), 18));

  const packages = await Promise.all(
    packageNames.map((name) => fetchDownloadsForPackage(name, startDate, endDate)),
  );

  const totalDownloads = packages.reduce(
    (sum, pkg) => sum + (typeof pkg.downloads === "number" ? pkg.downloads : 0),
    0,
  );

  const summary = {
    period: {
      label: "npm公开接口最长窗口",
      start: startDate,
      end: endDate,
      months: 18,
    },
    scope: "openclaw-china",
    totalDownloads,
    packages,
    unavailablePackages: packages
      .filter((pkg) => pkg.status !== "ok")
      .map(({ name, status, error }) => ({ name, status, error })),
  };

  const badge = {
    schemaVersion: 1,
    label: "downloads",
    message: formatNumber(totalDownloads),
    color: "#2ea4ff",
  };

  const badgeSvg = renderBadgeSvg(badge);

  const badgeDir = path.join(repoRoot, BADGE_DIR);
  await mkdir(badgeDir, { recursive: true });
  await writeJson(path.join(badgeDir, BADGE_FILE), badge);
  await writeFile(path.join(badgeDir, BADGE_SVG_FILE), badgeSvg, "utf8");
  await writeJson(path.join(badgeDir, SUMMARY_FILE), summary);

  console.log(
    `Updated npm downloads badge: ${formatNumber(totalDownloads)} across ${packages.length} packages (${startDate} -> ${endDate}).`,
  );

  const unavailable = summary.unavailablePackages;
  if (unavailable.length > 0) {
    console.warn("Packages without download data:", unavailable);
  }
}

async function discoverScopedPackages() {
  const rootPackageJson = await readJson(path.join(repoRoot, "package.json"));
  const workspaces = Array.isArray(rootPackageJson.workspaces) ? rootPackageJson.workspaces : [];
  const packageJsonPaths = [];

  for (const workspacePattern of workspaces) {
    if (typeof workspacePattern !== "string" || !workspacePattern.endsWith("/*")) {
      continue;
    }

    const workspaceDir = path.join(repoRoot, workspacePattern.slice(0, -2));
    let entries = [];

    try {
      entries = await readdir(workspaceDir, { withFileTypes: true });
    } catch (error) {
      console.warn(`Skipping workspace ${workspacePattern}:`, error);
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      packageJsonPaths.push(path.join(workspaceDir, entry.name, "package.json"));
    }
  }

  const packageNames = [];

  for (const packageJsonPath of packageJsonPaths) {
    try {
      const packageJson = await readJson(packageJsonPath);
      if (
        typeof packageJson.name === "string" &&
        packageJson.name.startsWith(SCOPE_PREFIX) &&
        packageJson.private !== true
      ) {
        packageNames.push(packageJson.name);
      }
    } catch (error) {
      console.warn(`Skipping ${path.relative(repoRoot, packageJsonPath)}:`, error);
    }
  }

  return packageNames.sort((a, b) => a.localeCompare(b));
}

async function fetchDownloadsForPackage(name, startDate, endDate) {
  const url = new URL(
    `https://api.npmjs.org/downloads/point/${startDate}:${endDate}/${encodeURIComponent(name)}`,
  );

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "user-agent": "openclaw-china-download-badge/1.0",
      },
    });

    const body = await response.json();

    if (!response.ok) {
      return {
        name,
        downloads: 0,
        status: "unavailable",
        error: typeof body?.error === "string" ? body.error : `HTTP ${response.status}`,
      };
    }

    return {
      name,
      downloads: typeof body.downloads === "number" ? body.downloads : 0,
      status: "ok",
      range: {
        start: body.start ?? startDate,
        end: body.end ?? endDate,
      },
    };
  } catch (error) {
    return {
      name,
      downloads: 0,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function monthsAgoUtc(date, months) {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  copy.setUTCMonth(copy.getUTCMonth() - months);
  return copy;
}

function formatDateUTC(date) {
  return date.toISOString().slice(0, 10);
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function renderBadgeSvg({ label, message, color }) {
  const leftWidth = computeBadgeWidth(label);
  const rightWidth = computeBadgeWidth(message);
  const totalWidth = leftWidth + rightWidth;
  const leftCenter = Math.round(leftWidth / 2);
  const rightCenter = leftWidth + Math.round(rightWidth / 2);
  const title = `${label}: ${message}`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${escapeXml(title)}">`,
    `<title>${escapeXml(title)}</title>`,
    '<linearGradient id="s" x2="0" y2="100%">',
    '<stop offset="0" stop-color="#bbb" stop-opacity=".1"/>',
    '<stop offset="1" stop-opacity=".1"/>',
    "</linearGradient>",
    '<mask id="m">',
    `<rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>`,
    "</mask>",
    '<g mask="url(#m)">',
    `<rect width="${leftWidth}" height="20" fill="#555"/>`,
    `<rect x="${leftWidth}" width="${rightWidth}" height="20" fill="${escapeXml(color)}"/>`,
    `<rect width="${totalWidth}" height="20" fill="url(#s)"/>`,
    "</g>",
    '<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">',
    `<text x="${leftCenter}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(label)}</text>`,
    `<text x="${leftCenter}" y="14">${escapeXml(label)}</text>`,
    `<text x="${rightCenter}" y="15" fill="#010101" fill-opacity=".3">${escapeXml(message)}</text>`,
    `<text x="${rightCenter}" y="14">${escapeXml(message)}</text>`,
    "</g>",
    "</svg>",
    "",
  ].join("");
}

function computeBadgeWidth(text) {
  const units = Array.from(text).reduce((sum, char) => sum + glyphWidth(char), 0);
  return Math.max(20, Math.round(units + 10));
}

function glyphWidth(char) {
  if ("ijlI1' ".includes(char)) {
    return 3.5;
  }

  if ("ftr()[]{}".includes(char)) {
    return 4.5;
  }

  if ("JKLsvxyz023456789".includes(char)) {
    return 6;
  }

  if ("ABCEFGHNPQRSTUVXYZabdghknopqu$#*+-<>=?_~".includes(char)) {
    return 7;
  }

  if ("mwMOW%&".includes(char)) {
    return 9;
  }

  return 6.5;
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function readJson(filePath) {
  const content = await readFile(filePath, "utf8");
  return JSON.parse(content);
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

main().catch((error) => {
  console.error("Failed to update npm downloads badge.", error);
  process.exitCode = 1;
});
