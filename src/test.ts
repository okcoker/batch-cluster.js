#!/usr/bin/env node
import { delay } from './Async.ts';
import { Mutex } from './Mutex.ts';
import { seedrandom /*, split2 */ } from '../deps.ts';

/**
 * This is a script written to behave similarly to ExifTool or
 * GraphicsMagick's batch-command modes. It is used for integration tests.
 *
 * The complexity comes from introducing predictable flakiness.
 */

const newline = Deno.env.get('newline') === 'crlf' ? '\r\n' : '\n';

async function write(s: string): Promise<boolean> {
	await Deno.stdout.write(new TextEncoder().encode(s + newline));
	return true;
}

const ignoreExit = Deno.env.get('ignoreExit') === '1';

function toF(s: string | undefined) {
	if (s == null) return;
	const f = parseFloat(s);
	return isNaN(f) ? undefined : f;
}

const failrate = toF(Deno.env.get('failrate')) ?? 0;
const rng = Deno.env.get('rngseed') != null
	? seedrandom(Deno.env.get('rngseed'))
	: Math.random;

async function onLine(line: string): Promise<void> {
	// write(`# ${_p.pid} onLine(${line.trim()}) (newline = ${process.env.newline})`)
	const r = rng();
	if (r < failrate) {
		if (Deno.env.get('unluckyfail') === '1') {
			// Make sure streams get debounced:
			await write('FAIL');
			await delay(1);
		}
		console.error(
			'EUNLUCKY: r: ' +
				r.toFixed(2) +
				', failrate: ' +
				failrate.toFixed(2) +
				', seed: ' +
				Deno.env.get('rngseed'),
		);

		return;
	}
	line = line.trim();
	const tokens = line.split(/\s+/);
	const firstToken = tokens.shift();

	// support multi-line outputs:
	const postToken = tokens.join(' ').split('<br>').join(newline);

	try {
		switch (firstToken) {
			case 'flaky': {
				const flakeRate = toF(tokens.shift()) ?? failrate;
				write(
					'flaky response (' +
						(r < flakeRate ? 'FAIL' : 'PASS') +
						', r: ' +
						r.toFixed(2) +
						', flakeRate: ' +
						flakeRate.toFixed(2) +
						// Extra information is used for context:
						(tokens.length > 0 ? ', ' + tokens.join(' ') : '') +
						')',
				);
				if (r < flakeRate) {
					write('FAIL');
				} else {
					write('PASS');
				}
				break;
			}

			case 'upcase': {
				write(postToken.toUpperCase());
				write('PASS');
				break;
			}
			case 'downcase': {
				write(postToken.toLowerCase());
				write('PASS');
				break;
			}
			case 'sleep': {
				const millis = parseInt(tokens[0] ?? '100');
				await delay(millis);
				write(JSON.stringify({ slept: millis, pid: Deno.pid }));
				write('PASS');
				break;
			}

			case 'version': {
				write('v1.2.3');
				write('PASS');
				break;
			}

			case 'exit': {
				if (ignoreExit) {
					write('ignoreExit is set');
				} else {
					Deno.exit(0);
				}
				break;
			}
			case 'stderr': {
				// force stdout to be emitted before stderr, and exercise stream
				// debouncing:
				write('PASS');
				await delay(1);
				console.error('Error: ' + postToken);
				break;
			}
			default: {
				console.error('invalid or missing command for input', line);
				write('FAIL');
			}
		}
	} catch (err) {
		console.error('Error: ' + err);
		write('FAIL');
	}
	return;
}

// @todo
// const m = new Mutex()

// process.stdin
//   .pipe(split2())
//   .on("data", (ea: string) => m.serial(() => onLine(ea)))
