// Open dialog stack (reactive state read by DialogHost). Do not use directly: `openDialog`.
import type { Component } from 'svelte';

export interface DialogEntry {
  key: number;
  id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: Component<any>;
  props: Record<string, unknown>;
  resolve: (result: unknown) => void;
}

class DialogStack {
  entries = $state.raw<DialogEntry[]>([]);
  #seq = 0;

  push(e: Omit<DialogEntry, 'key'>): number {
    const key = ++this.#seq;
    this.entries = [...this.entries, { ...e, key }];
    return key;
  }

  /** Closes (retirement and resolves) a precise dialogue; without effect if already closed. */
  close(key: number, result?: unknown): void {
    const e = this.entries.find((x) => x.key === key);
    if (!e) return;
    this.entries = this.entries.filter((x) => x.key !== key);
    e.resolve(result);
  }

  get top(): DialogEntry | null {
    return this.entries[this.entries.length - 1] ?? null;
  }

  closeTop(result?: unknown): void {
    const top = this.top;
    if (top) this.close(top.key, result);
  }

  closeAll(): void {
    for (const e of [...this.entries]) this.close(e.key);
  }
}

export const dialogStack = new DialogStack();
