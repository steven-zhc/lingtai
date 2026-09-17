import { isSea } from "node:sea";
import workspace from "../../../package.json" with { type: "json" };

/**
 * What `lingtai version` says (#185): the version, and which of the four
 * artifacts this is — a binary copies the Node that built it, so the platform
 * is part of what was shipped, not a detail of the machine.
 *
 * The version is the workspace's, read at import: from the source that is the
 * checkout's `package.json`, and bundled it is inlined by esbuild, so the binary
 * reports the version it was built at.
 */
export function platformName(platform: string = process.platform, arch: string = process.arch): string {
  return `${platform === "darwin" ? "macos" : platform}-${arch}`;
}

export function versionLine(): string {
  const form = isSea() ? "binary" : "script";
  return `lingtai ${workspace.version} ${platformName()} (${form}, node ${process.version})`;
}
