const MIN_SECRET_CHARS = 8;
const MAX_SECRET_CHARS = 4096;
const MAX_SECRETS = 128;
const MAX_TOTAL_CHARS = 64 * 1024;

export class KnownDiagnosticSecrets {
  private readonly values = new Set<string>();
  private totalChars = 0;
  private matcher: RegExp | undefined;

  remember(value: unknown): void {
    if (
      typeof value !== "string" ||
      value.length < MIN_SECRET_CHARS ||
      value.length > MAX_SECRET_CHARS ||
      this.values.has(value)
    )
      return;
    while (
      this.values.size >= MAX_SECRETS ||
      this.totalChars + value.length > MAX_TOTAL_CHARS
    ) {
      const oldest = this.values.values().next().value!;
      this.values.delete(oldest);
      this.totalChars -= oldest.length;
    }
    this.values.add(value);
    this.totalChars += value.length;
    this.matcher = undefined;
  }

  redact(text: string): string {
    if (!this.values.size) return text;
    this.matcher ||= new RegExp(
      [...this.values]
        .sort((left, right) => right.length - left.length)
        .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|"),
      "g",
    );
    return text.replace(this.matcher, "[redacted]");
  }
}
