import { stream } from '../deps.ts';

export function end(
    endable: stream.Writable,
    contents?: string,
): Promise<void> {
    return new Promise<void>((resolve) => endable.end(contents, resolve));
}

export function mapNotDestroyed<T extends Deno.Writer | Deno.Reader, R>(
    obj: T | undefined | null,
    f: (t: T) => R,
): R | undefined {
    return obj != null ? f(obj) : undefined;
}
