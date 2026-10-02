// Application-wide: an updater installation freezes all repository sessions together.
class Lifecycle { updating = $state(false); }
export const lifecycle = new Lifecycle();
