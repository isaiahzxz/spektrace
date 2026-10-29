/** Returns false when the browser refuses the write. A refusal must leave the previous value in place. */
export function writeStoredText(storage: Pick<Storage, "setItem">, key: string, value: string): boolean {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
