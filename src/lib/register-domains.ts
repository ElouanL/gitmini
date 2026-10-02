// Automatic domain registration: all `src/lib/components/**/register.ts` is imported (onboard effect) on startup.
// A `register.ts` calls `registerDialog`, `registerMenuItems`, `registerAction`, `registerRightPanel`, `registerCenterView`,
// `registerDrawer`, `registerPopover`, `registerErrorHandler`... No other files to change to connect a domain.
const modules = import.meta.glob('./components/**/register.ts', { eager: true });

export const registeredDomainModules: string[] = Object.keys(modules);
