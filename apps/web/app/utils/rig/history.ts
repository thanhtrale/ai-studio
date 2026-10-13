/**
 * Undo and redo for the rig editor.
 *
 * An entry knows how to undo and redo itself, so a bone move (a snapshot of a
 * small array) and a paint stroke (the before-images of the vertices it
 * touched) sit on the same stack. A new entry clears the redo side, as in
 * every editor.
 */

export interface HistoryEntry {
  label: string;
  undo: () => void;
  redo: () => void;
}

export class History {
  private done: HistoryEntry[] = [];
  private undone: HistoryEntry[] = [];

  constructor(
    private readonly limit = 200,
    private readonly changed: () => void = () => {},
  ) {}

  push(entry: HistoryEntry): void {
    this.done.push(entry);
    if (this.done.length > this.limit) this.done.shift();
    this.undone = [];
    this.changed();
  }

  undo(): HistoryEntry | null {
    const entry = this.done.pop();
    if (!entry) return null;
    entry.undo();
    this.undone.push(entry);
    this.changed();
    return entry;
  }

  redo(): HistoryEntry | null {
    const entry = this.undone.pop();
    if (!entry) return null;
    entry.redo();
    this.done.push(entry);
    this.changed();
    return entry;
  }

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  /** What Undo would undo, for its tooltip. */
  get nextUndo(): string | null {
    return this.done.at(-1)?.label ?? null;
  }

  get nextRedo(): string | null {
    return this.undone.at(-1)?.label ?? null;
  }

  clear(): void {
    this.done = [];
    this.undone = [];
    this.changed();
  }
}
