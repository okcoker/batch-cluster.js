import { blank, toS } from './String.ts';

/**
 * When we wrap errors, an Error always prefixes the toString() and stack with
 * "Error: ", so we can remove that prefix.
 */
export async function tryEach(arr: (() => void)[]): Promise<void> {
	for (const f of arr) {
		try {
			await f();
		} catch (_) {
			//
		}
	}
}

export function cleanError(s: any): string {
	return String(s)
		.trim()
		.replace(/^error: /i, '');
}

export function asError(err: any): Error {
	return err instanceof Error
		? err
		: new Error(blank(err) ? '(unknown)' : toS(err));
}
