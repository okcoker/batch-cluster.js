import { expect, use } from 'https://cdn.skypack.dev/chai@4.3.4?dts';
import * as timekeeper from 'https://cdn.skypack.dev/timekeeper@2.2.0?dts';
import { default as chaiString } from 'https://cdn.skypack.dev/chai-string@1.5.0?dts';
import { default as chaiAsPromised } from 'https://cdn.skypack.dev/chai-as-promised@7.1.1?dts';
import { default as chaiWithinTolerance } from 'https://cdn.skypack.dev/chai-withintoleranceof@1.0.1?dts';
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	it,
	test,
	TestSuite,
} from 'https://deno.land/x/test_suite@0.9.5/mod.ts';
import { assertEquals } from 'https://deno.land/std@0.122.0/testing/asserts.ts';
import { path } from './deps.ts';
import { Log, logger, setLogger } from './Logger.ts';
import { orElse } from './Object.ts';
import { Parser } from './Parser.ts';
import { pids } from './Pids.ts';
import { notBlank } from './String.ts';

const __dirname = path.dirname(path.fromFileUrl(import.meta.url));

use(chaiString);
use(chaiAsPromised);
use(chaiWithinTolerance);

// Tests should be quiet unless LOG is set
setLogger(
	Log.withLevels(
		Log.withTimestamps(
			Log.filterLevels(
				{
					// tslint:disable: no-unbound-method
					trace: console.log,
					debug: console.log,
					info: console.log,
					warn: console.warn,
					error: console.error,
					// tslint:enable: no-unbound-method
				},
				(Deno.env.get('LOG') as any) ?? 'error',
			),
		),
	),
);

export const parserErrors: string[] = [];

export const unhandledRejections: Error[] = [];

export const parser: Parser<string> = (
	stdout: string,
	stderr: string | undefined,
	passed: boolean,
) => {
	if (stderr != null) {
		parserErrors.push(stderr);
	}
	if (!passed || notBlank(stderr)) {
		logger().debug('test parser: rejecting task', {
			stdout,
			stderr,
			passed,
		});
		throw new Error(stderr);
	} else {
		const str = stdout
			.split(/(\r?\n)+/)
			.filter((ea) => notBlank(ea) && !ea.startsWith('# '))
			.join('\n')
			.trim();
		logger().debug('test parser: resolving task', str);
		return str;
	}
};

export function times<T>(n: number, f: (idx: number) => T): T[] {
	return Array(n)
		.fill(undefined)
		.map((_, i) => f(i));
}

// because @types/chai-withintoleranceof isn't a thing (yet)

type WithinTolerance = (
	expected: number,
	tol: number | number[],
	message?: string,
) => Chai.Assertion;

// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace Chai {
	interface Assertion {
		withinToleranceOf: WithinTolerance;
		withinTolOf: WithinTolerance;
	}
}

export const procs: Deno.Process[] = [];

export function testPids(): number[] {
	return procs.map((proc) => proc.pid).filter((ea) => ea != null) as number[];
}

export async function currentTestPids(): Promise<number[]> {
	const alivePids = new Set(await pids());
	return testPids().filter((ea) => alivePids.has(ea));
}

export function sortNumeric(arr: number[]): number[] {
	return arr.sort((a, b) => a - b);
}

export function flatten<T>(arr: (T | T[])[], result: T[] = []): T[] {
	arr.forEach((ea) =>
		Array.isArray(ea) ? result.push(...ea) : result.push(ea)
	);
	return result;
}

// Seeding the RNG deterministically _should_ give us repeatable
// flakiness/successes.

// We want a rngseed that is stable for consecutive tests, but changes sometimes
// to make sure different error pathways are exercised. YYYY-MM-$callcount
// should do it.

const rngseedPrefix = new Date().toISOString().substr(0, 7) + '.';
let rngseedCounter = 0;
let rngseedOverride: string | undefined;

export function setRngseed(seed?: string) {
	rngseedOverride = seed;
}

function rngseed() {
	// We need a new rngseed for every execution, or all runs will either pass or
	// fail:
	return orElse(rngseedOverride, () => rngseedPrefix + rngseedCounter++);
}

let failrate = '0.05'; // 5%

export function setFailrate(percent = 10) {
	failrate = (percent / 100).toFixed(2);
}

let unluckyfail = '1';

/**
 * Should EUNLUCKY be handled properly by the test script, and emit a "FAIL", or
 * require batch-cluster to timeout the job?
 *
 * Basically setting unluckyfail to true is worst-case behavior for a script,
 * where all flaky errors require a timeout to recover.
 */
export function setUnluckyFail(b = true) {
	unluckyfail = b ? '1' : '0';
}

let newline = 'lf';

export function setNewline(eol: 'lf' | 'crlf' = 'lf') {
	newline = eol;
}

let ignoreExit: '1' | '0' = '0';

export function setIgnoreExit(ignore = false) {
	ignoreExit = ignore ? '1' : '0';
}

type TestFunction = () => void;
type CreateSuiteOptions = {
	beforeEach?: TestFunction;
	afterEach?: TestFunction;
	beforeAll?: TestFunction;
	afterAll?: TestFunction;
};

export function createTestSuite<T>(
	name: string,
	options: CreateSuiteOptions = {},
): TestSuite<T> {
	return new TestSuite({
		name: name,
		beforeAll() {
			options.afterAll?.();
		},

		beforeEach() {
			parserErrors.length = 0;
			setFailrate();
			setUnluckyFail();
			setNewline();
			setIgnoreExit();
			setRngseed();
			options.beforeEach?.();
		},
		afterEach() {
			expect(unhandledRejections).to.eql([]);
			options.afterEach?.();
		},

		afterAll() {
			options.afterAll?.();
		},
	});
}

export const processFactory = () => {
	const proc = Deno.run({
		cmd: [Deno.execPath(), path.join(__dirname, 'test.js')],
		env: {
			rngseed: rngseed(),
			failrate,
			newline,
			ignoreExit,
			unluckyfail,
		},
	});
	procs.push(proc);
	return proc;
};

export {
	afterAll,
	afterEach,
	assertEquals,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	test,
	timekeeper,
};
