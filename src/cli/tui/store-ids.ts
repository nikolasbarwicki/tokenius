// Monotonic id generator. Shared between store.ts and store-event.ts so each
// block id is unique across the whole store regardless of which file emitted it.

let counter = 0;

export function makeId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}
