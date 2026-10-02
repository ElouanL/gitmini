// repository menu status (`graph-drop-menu`), shared between the drag and drop controller (document) and the component.
import { dropOptions, type DragRef, type DropOptions } from './model/dnd';

export interface DropMenuState {
  x: number;
  y: number;
  src: DragRef;
  dst: DragRef;
  options: DropOptions;
}

class DndStore {
  menu = $state.raw<DropMenuState | null>(null);

  open(src: DragRef, dst: DragRef, x: number, y: number, head: { branch: string | null; detached: boolean }): void {
    this.menu = { x, y, src, dst, options: dropOptions(src, dst, head) };
  }

  close(): void {
    this.menu = null;
  }
}

export const dnd = new DndStore();
