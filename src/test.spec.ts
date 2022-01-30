import { until } from './Async.ts';
import { kill, pidExists } from './Pids.ts';
import {
	describe,
	expect,
	it,
	processFactory,
	ProcessEnv
} from './_chai.spec.ts';

/* eslint-disable @typescript-eslint/no-non-null-assertion */
describe('test.js', () => {
	class Harness {
		readonly child: Deno.Process;
		public output = '';
		constructor(env: ProcessEnv = {}) {
			this.child = processFactory({
				failrate: 0,
				...env
			});
		}

		async untilOutput(minLength = 0): Promise<boolean> {
			return await until(async () => {
				const buffered = new Uint8Array(512);
				const length = await this.child.stdout!.read(buffered);
				if (length) {
					this.output += new TextDecoder().decode(buffered.slice(0, length));
				}
				return this.output.length > minLength;
			}, 1000);
		}

		async end(): Promise<void> {
			try { this.child.stdin!.close(); } catch(_) { /**/ }
			try { this.child.stdout!.close(); } catch(_) { /**/ }
			try { this.child.stderr!.close(); } catch(_) { /**/ }
			this.child.close();

			await until(() => this.notRunning(), 1000);

			if (await this.running()) {
				console.error('Ack, I had to kill child pid ' + this.child.pid);
				kill(this.child.pid);
			}
		}

		running(): Promise<boolean> {
			return pidExists(this.child.pid);
		}

		notRunning(): Promise<boolean> {
			return this.running().then((ea) => !ea);
		}

		async getChildStdOut() {
			const [status, rawOutput, rawError] = await Promise.all([
				this.child.status(),
				this.child.output(),
				this.child.stderrOutput()
			]);
			const { code } = status;

			if (code !== 0) {
				throw new TextDecoder().decode(rawError);
			}

			this.output = new TextDecoder().decode(rawOutput);

			return this.output;
		}

		async assertStdout(f: (output: string) => void) {
			// The OS may take a bit before the PID shows up in the process table:
			const alive = await until(() => pidExists(this.child.pid), 2000);
			expect(alive).to.eql(true);

			const output = await this.getChildStdOut();

			await this.end();

			await f(output.trim());
		}
	}

	it('results in expected output', () => {
		const h = new Harness();
		const a = h.assertStdout((ea) => {
			expect(ea).to.eql('HELLO\nPASS\nworld\nPASS\nFAIL\nv1.2.3\nPASS');
		});

		h.child.stdin!.write(
			new TextEncoder().encode('upcase Hello\ndowncase World\ninvalid input\nversion\n')
		).then(() => {
			h.child.stdin!.close();
		});

		return a;
	});

	it('exits properly if ignoreExit is not set', async () => {
		const h = new Harness();
		h.child.stdin!.write(new TextEncoder().encode('upcase fuzzy\nexit\n'));
		await h.untilOutput(9);
		await h.end();
		expect(h.output).to.eql('FUZZY\nPASS\n');
		await until(() => h.notRunning(), 500);
		expect(await h.running()).to.eql(false);
	});

	it('kill(!force) with ignoreExit set doesn\'t cause the process to end', async () => {
		const h = new Harness({
			ignoreExit: true
		});
		h.child.stdin!.write(new TextEncoder().encode('upcase fuzzy\n'));
		await h.untilOutput();
		kill(h.child.pid, false);
		await until(() => h.notRunning(), 500);
		expect(await h.running()).to.eql(true);
		await h.end();
	});

	it('kill(force) with ignoreExit unset causes the process to end', async () => {
		const h = new Harness({
			ignoreExit: false
		});
		h.child.stdin!.write(new TextEncoder().encode('upcase fuzzy\n'));
		await h.untilOutput();
		kill(h.child.pid, true);
		// This process wont be killed until we check status()
		// https://github.com/denoland/deno/issues/7087
		const { code, signal } = await h.child.status();

		// close out ops
		if (code) {
			if (!signal) {
				console.log('\n\nNote: Sometimes this test is flakey and ends up here. This might be related to the kill issue listed above? Other times signal is appropriately filled');
			}
			await h.end();
		}

		await until(() => h.notRunning(), 500);
		expect(await h.running()).to.eql(false);
	});

	it('kill(force) even with ignoreExit set causes the process to end', async () => {
		const h = new Harness({
			ignoreExit: true
		});
		h.child.stdin!.write(new TextEncoder().encode('upcase fuzzy\n'));
		await h.untilOutput();
		kill(h.child.pid, true);
		// This process wont be killed until we check status()
		// https://github.com/denoland/deno/issues/7087
		const { code, signal } = await h.child.status();
		// close out ops
		if (code) {
			if (!signal) {
				console.log('\n\nNote: Sometimes this test is flakey and ends up here. This might be related to the kill issue listed above? Other times signal is appropriately filled');
			}
			await h.end();
		}
		await until(() => h.notRunning(), 500);
		expect(await h.running()).to.eql(false);
	});

	it('doesn\'t exit if ignoreExit is set', async () => {
		const h = new Harness({
			ignoreExit: true
		});
		h.child.stdin!.write(new TextEncoder().encode('upcase Boink\nexit\n'));
		await h.untilOutput('BOINK\nPASS\nignore'.length);
		expect(h.output).to.eql('BOINK\nPASS\nignoreExit is set\n');
		expect(await h.running()).to.eql(true);
		await h.end();
		expect(await h.running()).to.eql(false);
	});

	it('returns a valid pid', async () => {
		const h = new Harness();
		expect(await pidExists(h.child.pid)).to.eql(true);
		await h.end();
	});

	it('sleeps serially', () => {
		const h = new Harness();
		const start = Date.now();
		const times = [200, 201, 202];
		const a = h
			.assertStdout((output) => {
				const actualTimes: number[] = [];
				const pids = new Set();
				output.split(/[\r\n]/).forEach((line) => {
					if (line.startsWith('{') && line.endsWith('}')) {
						const json = JSON.parse(line);
						actualTimes.push(json.slept);
						pids.add(json.pid);
					} else {
						expect(line).to.eql('PASS');
					}
				});
				expect(pids.size).to.eql(
					1,
					'only one pid should have been used',
				);
				expect(actualTimes).to.eql(times);
			})
			.then(() => expect(Date.now() - start).to.be.gte(603));
		h.child.stdin?.write(
			new TextEncoder().encode(times.map((ea) => 'sleep ' + ea).join('\n') + '\nexit\n')
		).then(() => {
			h.child.stdin?.close()
		});
		return a;
	});

	it('flakes out the first N responses', () => {
		const h = new Harness({
			failrate: 0,
			rngseed: 'hello'
		});
		// These random numbers are consistent because we have a consistent rngseed:
		const a = h.assertStdout((ea) =>
			expect(ea).to.eql(
				[
					'flaky response (PASS, r: 0.55, flakeRate: 0.50)',
					'PASS',
					'flaky response (PASS, r: 0.44, flakeRate: 0.00)',
					'PASS',
					'flaky response (FAIL, r: 0.55, flakeRate: 1.00)',
					'FAIL',
				].join('\n'),
			)
		);
		h.child.stdin?.write(new TextEncoder().encode('flaky .5\nflaky 0\nflaky 1\nexit\n')).then(() => {
			h.child.stdin?.close()
		});
		return a;
	});
});
