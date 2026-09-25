/** Select a compiler that is installed and can run on the native Windows host. */
export function selectWindowsSsoToolchain(target, nativeHost, installedHosts) {
  const candidates = nativeHost === "arm64" ? ["arm64", "x64"] : ["x64"];
  const host = candidates.find((candidate) => installedHosts.includes(candidate));
  if (!host) throw new Error(`No Windows SSO compiler for ${nativeHost} targeting ${target}`);
  const vcHost = host === "x64" ? "amd64" : "arm64";
  const vcTarget = target === "x64" ? "amd64" : "arm64";
  return host === target ? vcHost : `${vcHost}_${vcTarget}`;
}
