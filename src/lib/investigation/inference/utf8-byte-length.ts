export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function jsonUtf8ByteLength(value: unknown): number {
  return utf8ByteLength(JSON.stringify(value));
}
