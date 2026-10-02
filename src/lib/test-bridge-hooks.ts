// `window.__gitmini` Test Bridge Hanging Points . The deck itself (`test-bridge.ts`) is loaded only in the
// build e2e (`app_info.e2e`); a domain declares its part there without importing it:
//
//   exposeToBridge('graph',  => ({ rowOf, rowRect, refRect, visibleRange, lanesOf }))
//
// The factory is only called if the bridge is installed (at once if it is already done).
type Factory = () => unknown;
type Installer = (name: string, value: unknown) => void;

const parts = new Map<string, Factory>();
let installer: Installer | null = null;

export function exposeToBridge(name: string, factory: Factory): void {
  parts.set(name, factory);
  if (installer) installer(name, factory());
}

export function bridgeParts(): ReadonlyMap<string, Factory> {
  return parts;
}

/** Called by `test-bridge.ts` at the bridge installation. */
export function setBridgeInstaller(fn: Installer | null): void {
  installer = fn;
}
