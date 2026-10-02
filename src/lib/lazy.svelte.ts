// Components loaded on demand (budget: JS initial < 150 Ko gzippedd, ).
// accept an ordinary component OR a lazy load; the component is only downloaded at the first opening
// (separate chunk):
//
//   registerDialog('branch-create-dialog',  => import('./BranchCreateDialog.svelte'));
//   registerRightPanel('stash-detail-panel', lazy( => import('./StashDetailPanel.svelte')));   // forme explicite
//
// To load is a without parameter that returns `import(...)` (a Svelte component always has at least one parameter).
import { untrack, type Component } from 'svelte';
import { beginActivity } from './activity';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyComponent = Component<any>;
export type ComponentModule<C extends AnyComponent = AnyComponent> = { default: C };
export type Loader<C extends AnyComponent = AnyComponent> = () => Promise<ComponentModule<C> | C>;
export type Loadable<C extends AnyComponent = AnyComponent> = C | Loader<C> | LazyComponent;

export type LazyStatus = 'idle' | 'loading' | 'ready' | 'error';

/** A component that may not yet be loaded. `component` is reactive: a template that reads it updates when loading. */
export class LazyComponent {
  component = $state.raw<AnyComponent | null>(null);
  status = $state<LazyStatus>('idle');
  error = $state.raw<unknown>(null);

  readonly #loader: Loader | null;
  #promise: Promise<AnyComponent | null> | null = null;

  constructor(source: AnyComponent | Loader) {
    if (isLoader(source)) {
      this.#loader = source;
    } else {
      this.#loader = null;
      this.component = source;
      this.status = 'ready';
    }
  }

  /** Load the component (only once); returns `null` if the load fails (`status === 'error'`). */
  load(): Promise<AnyComponent | null> {
    // Never followed by a `$effect` calling: load writes `status`, which would revive the effect.
    return untrack(() => {
      if (this.status === 'ready') return Promise.resolve(this.component);
      this.#promise ??= this.#run();
      return this.#promise;
    });
  }

  /** Load only if nothing has yet been tried (panel display): a failure is not retrieved in a loop. */
  ensure(): void {
    if (untrack(() => this.status) === 'idle') void this.load();
  }

  async #run(): Promise<AnyComponent | null> {
    const loader = this.#loader;
    if (!loader) return this.component;
    this.status = 'loading';
    const end = beginActivity('lazy-load'); // window.__gitmini.idle awaits the chunk
    try {
      const mod = await loader();
      const comp = (mod && typeof mod === 'object' && 'default' in mod ? mod.default : mod) as AnyComponent;
      if (typeof comp !== 'function') throw new Error("the load did not return a component Svelte");
      this.component = comp;
      this.status = 'ready';
      return comp;
    } catch (e) {
      this.error = e;
      this.status = 'error';
      this.#promise = null; // a new opening try again
      console.error("[gitmini] Lazy loading in failure", e);
      return null;
    } finally {
      end();
    }
  }
}

function isLoader(x: unknown): x is Loader {
  return typeof x === 'function' && x.length === 0;
}

/** Forme explicite d'un chargeur paresseux. */
export function lazy<C extends AnyComponent>(loader: Loader<C>): LazyComponent {
  return new LazyComponent(loader as Loader);
}

/** Normalise ce qu'accepte un registre (composant, chargeur ou `LazyComponent`). */
export function toLazy(source: Loadable): LazyComponent {
  return source instanceof LazyComponent ? source : new LazyComponent(source);
}
