export const root: string;
export const COPIES: ReadonlyArray<{ from: string; to: string }>;
export function build(o?: { log?: (line: string) => void }): void;
