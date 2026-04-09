import { Data } from "effect";

export class NostrDmStartupError extends Data.TaggedError("NostrDmStartupError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `Nostr DM startup error: ${this.detail}`;
  }
}
