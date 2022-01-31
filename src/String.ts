import { isFunction } from './Object.ts';

export function blank(s: string | undefined): boolean {
	return !s || String(s).trim().length === 0;
}

export function notBlank(s: string | undefined): s is string {
	return !blank(s);
}

export function ensureSuffix(s: string, suffix: string): string {
	return s.endsWith(suffix) ? s : s + suffix;
}

export function toS(s: any): string {
	return s == null ? '' : isFunction(s.toString) ? s.toString() : String(s);
}
