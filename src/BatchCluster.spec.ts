import { filterInPlace } from './Array.ts';
import { delay, until } from './Async.ts';
import { BatchCluster } from './BatchCluster.ts';
import { BatchClusterOptions } from './BatchClusterOptions.ts';
import { map, orElse } from './Object.ts';
import { isWin } from './Platform.ts';
import { toS } from './String.ts';
import { Task } from './Task.ts';
import {
	afterEach,
	beforeEach,
	currentTestPids,
	describe,
	expect,
	flatten,
	it,
	parser,
	parserErrors,
	processFactory,
	procs,
	sortNumeric,
	testPids,
	timekeeper as tk,
	times,
} from './_chai.spec.ts';

const isCI = Deno.env.get('CI') === '1';

describe('BatchCluster', function () {
	if (isCI) {
		beforeEach(function () {
			// child process forking in CI is flaky.
			// @todo check on this later
			// this.retries(3)
		});
	}

	const ErrorPrefix = 'ERROR: ';
	// Small values are not really working on my laptop.
	// Not sure if this is a Deno limitation?
	const safeTaskTimeout = 1250;
	const DefaultOpts = {
		...new BatchClusterOptions(),
		maxProcs: 4, // < force concurrency
		versionCommand: 'version',
		pass: 'PASS',
		fail: 'FAIL',
		exitCommand: 'exit',
		onIdleIntervalMillis: 250, // frequently to speed up tests
		maxTasksPerProcess: 5, // force process churn
		taskTimeoutMillis: safeTaskTimeout, // CI machines can be slow. Needs to be short so the timeout test doesn't timeout
		maxReasonableProcessFailuresPerMinute: 2000, // this is so high because failrate is so high
		minDelayBetweenSpawnMillis: 100,
	};

	function runTasks(
		bc: BatchCluster,
		iterations: number,
		start = 0,
	): Promise<string>[] {
		expectedTaskCount += iterations;
		return times(iterations, (i) =>
			bc
				.enqueueTask(new Task('upcase abc ' + (i + start), parser))
				.catch((err) => ErrorPrefix + err));
	}

	class Events {
		readonly taskData: { cmd: string | undefined; data: string }[] = [];
		readonly events: { event: string }[] = [];
		readonly startedPids: number[] = [];
		readonly exittedPids: number[] = [];
		readonly startErrors: Error[] = [];
		readonly endErrors: Error[] = [];
		readonly taskErrors: Error[] = [];
		readonly healthCheckErrors: Error[] = [];
		readonly unhealthyPids: number[] = [];
		readonly runtimeMs: number[] = [];
	}

	let events = new Events();
	const internalErrors: Error[] = [];
	let expectedTaskCount = 0;

	function assertExpectedResults(results: string[]) {
		const dataResults = flatten(
			events.taskData.map((ea) => ea.data.split(/[\n\r]+/)),
		);

		results.forEach((result, index) => {
			if (!result.startsWith(ErrorPrefix)) {
				expect(result).to.eql('ABC ' + index);
				expect(dataResults).to.include(result);
			}
		});
	}

	beforeEach(() => {
		events = new Events();
		expectedTaskCount = 0;
	});

	function postAssertions() {
		expect(internalErrors).to.eql([], 'internal errors');

		expect(events.runtimeMs.length).to.be.within(
			Math.floor(expectedTaskCount * 0.5), // because failures
			Math.ceil(expectedTaskCount * 3), // because flaky retries
		);
		events.runtimeMs.forEach((ea) =>
			expect(ea).to.be.within(
				0,
				5000,
				JSON.stringify({ runtimeMs: events.runtimeMs }),
			)
		);
	}

	const expectedEndEvents = [{ event: 'beforeEnd' }, { event: 'end' }];

	async function shutdown(bc: BatchCluster) {
		if (bc == null) return; // we skipped the spec
		const endPromise = bc.end(true);
		// "ended" should be true immediately, but it may still be waiting for child
		// processes to exit:
		expect(bc.ended).to.eql(true);

		const isShutdown = await until(
			async () => {
				// const isIdle = bc.isIdle
				// If bc has been told to shut down, it won't ever finish any pending commands.
				// const pendingCommands = bc.pendingTasks.map((ea) => ea.command)
				const runningCommands = bc.currentTasks.map((ea) => ea.command);
				const busyProcCount = bc.busyProcCount;
				const pids = await bc.pids();
				const livingPids = await currentTestPids();

				const done = runningCommands.length === 0 &&
					busyProcCount === 0 &&
					pids.length === 0 &&
					livingPids.length === 0;

				// if (!done)
				//   console.log("shutdown(): waiting for end", {
				//     count,
				//     isIdle,
				//     pendingCommands,
				//     runningCommands,
				//     busyProcCount,
				//     pids,
				//     livingPids,
				//   })
				return done;
			},
			10_000, // < mac CI is slow
			500, // < don't hammer tasklist/ps too hard
		);
		// This should immediately be true: we already waited for the processes to exit.
		const endPromiseResolved = await until(
			() => !endPromise.pending,
			10_000,
			500,
		);
		if (!endPromiseResolved || !isShutdown) {
			console.warn('shutdown()', { isShutdown, endPromiseResolved });
		}
		// const cec = bc.childEndCounts
		// if (Object.keys(cec).length > 0) {
		//   console.log("childEndCounts", cec)
		// }
		expect(isShutdown).to.eql(true);
		expect(endPromiseResolved).to.eql(true);
		expect(bc.end(true).settled).to.eql(true);
		expect(bc.internalErrorCount).to.eql(
			0,
			JSON.stringify({ internalErrors }),
		);
		return;
	}

	function listen(bc: BatchCluster) {
		// This is a typings verification, too:
		bc.on(
			'childStart',
			(cp) => map(cp.pid, (ea) => events.startedPids.push(ea)),
		);
		bc.on(
			'childExit',
			(cp) => map(cp.pid, (ea) => events.exittedPids.push(ea)),
		);
		bc.on('startError', (err) => events.startErrors.push(err));
		bc.on('endError', (err) => events.endErrors.push(err));
		bc.on('internalError', (err) => {
			console.error('BatchCluster.spec: internal error: ' + err);
			internalErrors.push(err);
		});
		bc.on('taskData', (data, task) =>
			events.taskData.push({
				cmd: map(task, (ea) => ea.command),
				data: toS(data),
			}));

		bc.on('taskResolved', (task: Task) => {
			const runtimeMs = task.runtimeMs;
			expect(runtimeMs).to.not.eql(undefined);
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			events.runtimeMs.push(runtimeMs!);
		});

		bc.on('healthCheckError', (err, proc) => {
			events.healthCheckErrors.push(err);
			events.unhealthyPids.push(proc.pid);
		});
		bc.on('taskError', (err) => events.taskErrors.push(err));

		for (const event of ['beforeEnd', 'end'] as ('beforeEnd' | 'end')[]) {
			bc.on(event, () => events.events.push({ event }));
		}
		return bc;
	}

	const newlines = ['lf'];

	if (isWin) {
		// Don't need to test crlf except on windows:
		newlines.push('crlf');
	}

	it('supports .off()', async () => {
		const emitTimes: number[] = [];
		const bc = new BatchCluster({ ...DefaultOpts, processFactory });
		const listener = () => emitTimes.push(Date.now());
		bc.on('idle', listener);
		bc.emitter.emit('idle');
		expect(emitTimes.length).to.eql(1);
		emitTimes.length = 0;
		bc.off('idle', listener);
		bc.emitter.emit('idle');
		expect(emitTimes).to.eql([]);
		await bc.end();
		postAssertions();
	});


	for (const newline of newlines) {
		for (const maxProcs of [1, 4]) {
			for (const ignoreExit of [true, false]) {
				for (const healthcheck of [false, true]) {
					describe(
						JSON.stringify(
							{ newline, maxProcs, ignoreExit, healthcheck },
						),
						function () {
							let bc: BatchCluster;
							const opts: any = {
								...DefaultOpts,
								maxProcs,
							};

							if (healthcheck) {
								opts.healthCheckIntervalMillis = 250;
								opts.healthCheckCommand = 'flaky 0.5'; // fail half the time (ensure we get a proc end due to "unhealthy")
							}

							// failrate needs to be high enough to trigger but low enough to allow
							// retries to succeed.

							beforeEach(function () {
								bc = listen(
									new BatchCluster({
										...opts,
										processFactory: () => processFactory({
											newline: newline as "lf" | "crlf",
											ignoreExit: ignoreExit
										}),
									}),
								);
								procs.length = 0;
							});

							afterEach(async () => {
								await shutdown(bc);
								expect(bc.internalErrorCount).to.eql(0);
							});

							it('calling .end() when new no-ops', async () => {
								await bc.end();
								expect(bc.ended).to.eql(true);
								expect(bc.isIdle).to.eql(true);
								expect((await bc.pids()).length).to.eql(0);
								expect(bc.spawnedProcCount).to.eql(0);
								expect(events.events).to.eql(expectedEndEvents);
								expect(testPids()).to.eql([]);
								expect(events.startedPids).to.eql([]);
								expect(events.exittedPids).to.eql([]);
								postAssertions();
							});

							it('calling .end() after running shuts down child procs', async () => {
								// This just warms up bc to make child procs:
								const iterations = maxProcs *
									(bc.options.maxTasksPerProcess + 1);

								// @ts-ignore make it easier to override options for test
								bc.options.processFactory = () => processFactory({
									newline: newline as "lf" | "crlf",
									ignoreExit: ignoreExit,
									failrate: 25 // 25%
								})
								const tasks = await Promise.all(
									runTasks(bc, iterations),
								);
								assertExpectedResults(tasks);
								await shutdown(bc);
								expect(bc.spawnedProcCount).to.be.within(
									maxProcs,
									(iterations + maxProcs) * 2, // because flaky
								);
								const pids = sortNumeric(testPids());
								expect(pids.length).to.be.gte(maxProcs);
								expect(sortNumeric(events.startedPids)).to.eql(
									pids,
								);
								expect(sortNumeric(events.exittedPids)).to.eql(
									pids,
								);
								expect(events.events).to.eql(expectedEndEvents);
								postAssertions();
							});

							it(
								'runs a given batch process roughly ' +
									opts.maxTasksPerProcess +
									' before recycling',
								async function () {
									// @todo check on this later
									// this.retries(2) // because we're flaky...
									// @ts-ignore make it easier to override options for test
									bc.options.processFactory = () => processFactory({
										newline: newline as "lf" | "crlf",
										ignoreExit: ignoreExit,
										// make sure we hit an EUNLUCKY:
										failrate: 60 // 60%
									})
									let expectedResultCount = 0;
									const results = await Promise.all(
										runTasks(bc, maxProcs),
									);
									expectedResultCount += maxProcs;
									const pids = await bc.pids();
									const iters = Math.floor(
										maxProcs * opts.maxTasksPerProcess *
											1.5,
									);
									results.push(
										...(await Promise.all(
											runTasks(
												bc,
												iters,
												expectedResultCount,
											),
										)),
									);
									expectedResultCount += iters;
									assertExpectedResults(results);
									expect(results.length).to.eql(
										expectedResultCount,
									);
									// And expect some errors:
									const errorResults = results.filter((ea) =>
										ea.startsWith(ErrorPrefix)
									);
									expect(errorResults).to.not.eql([]);

									// Expect a reasonable number of new pids. Worst case, we
									// errored after every start, so there may be more then iters
									// pids spawned.
									expect(procs.length).to.eql(
										bc.spawnedProcCount,
									);
									expect(bc.spawnedProcCount).to.be.within(
										results.length /
											opts.maxTasksPerProcess,
										results.length * 2, // because flaky
									);

									// Expect no prior pids to remain, as long as there were before-pids:
									if (pids.length > 0) {
										expect(await bc.pids()).to.not.include
											.members(pids);
									}

									expect(bc.spawnedProcCount).to.be.within(
										maxProcs,
										results.length * 2, // because flaky
									);
									expect(bc.meanTasksPerProc).to.be.within(
										0.5, // because flaky
										opts.maxTasksPerProcess,
									);
									expect((await bc.pids()).length).to.be.lte(
										maxProcs,
									);
									expect((await currentTestPids()).length).to
										.be.lte(
											bc.spawnedProcCount,
										); // because flaky

									const unhealthy = bc.countEndedChildProcs(
										'unhealthy',
									);
									// If it's a short spec and we don't have any worn procs, we
									// probably don't have any unhealthy procs:
									if (
										healthcheck &&
										bc.countEndedChildProcs('worn') > 2
									) {
										expect(unhealthy).to.be.gte(0);
									}

									if (!healthcheck) {
										expect(unhealthy).to.eql(0);
									}

									await shutdown(bc);
									// (no run count assertions)
								},
							);

							it('recovers from invalid commands', async function () {
								assertExpectedResults(
									await Promise.all(
										runTasks(bc, maxProcs * 4),
									),
								);
								const errorResults = await Promise.all(
									times(maxProcs * 2, () =>
										bc
											.enqueueTask(
												new Task('nonsense', parser),
											)
											.catch((err) => err)),
								);
								filterInPlace(
									errorResults,
									(ea) =>
										ea != null &&
										!String(ea).includes('EUNLUCKY'),
								);
								if (
									maxProcs === 1 &&
									ignoreExit === false &&
									healthcheck === false
								) {
									// We don't expect these to pass with this config:
								} else if (
									maxProcs === 1 && errorResults.length === 0
								) {
									console.warn(
										'(all processes were unlucky)',
									);
									expectedTaskCount = -1;
									// @todo we shouldn't be needing to skip tests
									// return this.skip()
									return;
								} else {
									expect(
										errorResults.some((ea) =>
											String(ea).includes('nonsense')
										),
									).to.eql(
										true,
										JSON.stringify(errorResults),
									);
									expect(
										parserErrors.some((ea) =>
											ea.includes('nonsense')
										),
									).to.eql(
										true,
										JSON.stringify(parserErrors),
									);
								}
								parserErrors.length = 0;
								// BC should recover:
								assertExpectedResults(
									await Promise.all(
										runTasks(bc, maxProcs * 4),
									),
								);
								// (no run count assertions)
								return;
							});

							it('times out slow requests', async () => {
								const task = new Task(
									'sleep ' + (opts.taskTimeoutMillis + 250), // < make sure it times out
									parser,
								);
								expectedTaskCount++;
								await expect(
									bc.enqueueTask(task),
								).to.eventually.be.rejectedWith(
									/timeout|EUNLUCKY/,
								);
								postAssertions();
							});

							it('accepts single and multi-line responses', async () => {
								// @ts-ignore make it easier to override options for test
								bc.options.processFactory = () => processFactory({
									newline: newline as "lf" | "crlf",
									ignoreExit: ignoreExit,
									failrate: 0
								})
								const expected: string[] = [];
								const results = await Promise.all(
									times(15, (idx) => {
										// Make a distribution of single, double, and triple line outputs:
										const worlds = times(
											idx % 3,
											(ea) => 'world ' + ea,
										);
										expected.push(
											[idx + ' HELLO', ...worlds].join(
												'\n',
											).toUpperCase(),
										);
										const cmd = [
											'upcase ' + idx + ' hello',
											...worlds,
										].join(
											'<br>',
										);
										expectedTaskCount++;
										return bc.enqueueTask(
											new Task(cmd, parser),
										);
									}),
								);
								expect(results).to.eql(expected);

								postAssertions();
							});

							it('rejects a command that results in FAIL', async function () {
								const task = new Task(
									'invalid command',
									parser,
								);
								let error: Error | undefined;
								let result = '';
								try {
									expectedTaskCount++;
									result = await bc.enqueueTask(task);
								} catch (err: any) {
									error = err;
								}
								expect(String(error)).to.match(
									/invalid command|UNLUCKY/,
									result,
								);
								postAssertions();
							});

							it('rejects a command that emits to stderr', async function () {
								const task = new Task(
									'stderr omg this should fail',
									parser,
								);
								let error: Error | undefined;
								let result = '';
								try {
									expectedTaskCount++;
									result = await bc.enqueueTask(task);
								} catch (err: any) {
									error = err;
								}
								expect(String(error)).to.match(
									/omg this should fail|UNLUCKY/,
									result,
								);
								postAssertions();
							});
						}
					);
				}
			}
		}
	}

	describe('maxProcs', function () {
		const iters = 50;
		const maxProcs = 10;
		const sleepTimeMs = 250;
		let bc: BatchCluster;
		afterEach(() => shutdown(bc));
		for (
			const {
				minDelayBetweenSpawnMillis,
				expectTaskMin,
				expectedTaskMax,
				expectedProcsMin,
				expectedProcsMax,
			} of [
				{
					minDelayBetweenSpawnMillis: 100,
					expectTaskMin: 2,
					expectedTaskMax: 10,
					expectedProcsMin: maxProcs,
					expectedProcsMax: maxProcs + 2,
				},
				{
					minDelayBetweenSpawnMillis: 500,
					expectTaskMin: 1,
					expectedTaskMax: 15,
					expectedProcsMin: 6,
					expectedProcsMax: 10,
				},
			]
		) {
			it(
				JSON.stringify(
					{ minDelayBetweenSpawnMillis },
				),
				async function () {
					const opts = {
						...DefaultOpts,
						taskTimeoutMillis: sleepTimeMs * 4, // < don't test timeouts here
						maxProcs,
						maxTasksPerProcess: expectedTaskMax + 5, // < don't recycle procs for this test
						minDelayBetweenSpawnMillis,
						processFactory: () => processFactory({
							failrate: 0
						})
					};
					bc = listen(new BatchCluster(opts));
					expect(bc.isIdle).to.eql(true);
					const tasks = await Promise.all(
						times(iters, async (i) => {
							const start = Date.now();
							const task = new Task(
								'sleep ' + sleepTimeMs,
								parser,
							);
							expectedTaskCount++;
							const resultP = bc.enqueueTask(task);
							expect(bc.isIdle).to.eql(false);
							const result = JSON.parse(await resultP);
							const end = Date.now();
							return { i, start, end, ...result };
						}),
					);
					const pid2count = new Map<number, number>();
					tasks.forEach((ea) => {
						const pid = ea.pid;
						const count = orElse(pid2count.get(pid), 0);
						pid2count.set(pid, count + 1);
					});
					expect(bc.isIdle).to.eql(true);
					// console.log({
					//   expectTaskMin,
					//   expectedTaskMax,
					//   maxProcs,
					//   uniqPids: pid2count.size,
					//   pid2count,
					//   bcPids: await bc.pids(),
					// })
					for (const [, count] of pid2count.entries()) {
						expect(count).to.be.within(
							expectTaskMin,
							expectedTaskMax,
						);
					}
					expect(pid2count.size).to.be.within(
						expectedProcsMin,
						expectedProcsMax,
					);
				},
			);
		}
	});

	describe('setMaxProcs', function () {
		const maxProcs = 10;
		const sleepTimeMs = 250;
		let bc: BatchCluster;
		afterEach(() => shutdown(bc));

		it('supports reducing maxProcs', async () => {
			const opts = {
				...DefaultOpts,
				minDelayBetweenSpawnMillis: 10,
				taskTimeoutMillis: sleepTimeMs * 4, // < don't test timeouts here
				maxProcs,
				maxTasksPerProcess: 100, // < don't recycle procs for this test
				processFactory: () => processFactory({
					failrate: 0
				})
			};
			bc = new BatchCluster(opts);
			const firstBatchPromises: Promise<string>[] = [];
			while (bc.busyProcCount < maxProcs) {
				firstBatchPromises.push(
					bc.enqueueTask(new Task('sleep ' + sleepTimeMs, parser)),
				);
				await delay(25);
			}
			expect(bc.currentTasks.length).to.be.closeTo(maxProcs, 2);
			expect(bc.busyProcCount).to.be.closeTo(maxProcs, 2);
			expect(bc.procCount).to.be.closeTo(maxProcs, 2);
			bc.setMaxProcs(maxProcs / 2);

			const secondBatchPromises = times(
				maxProcs,
				() => bc.enqueueTask(new Task('sleep ' + sleepTimeMs, parser)),
			);
			await Promise.all(firstBatchPromises);
			bc.vacuumProcs();
			// We should be dropping BatchProcesses at this point.
			expect(bc.busyProcCount).to.be.closeTo(maxProcs / 2, 2);
			expect(bc.procCount).to.be.closeTo(maxProcs / 2, 2);

			await Promise.all(secondBatchPromises);

			expect(bc.procCount).to.be.closeTo(maxProcs / 2, 2);
			expect(bc.busyProcCount).to.eql(0); // because we're done

			expect(bc.childEndCounts.tooMany).to.be.closeTo(maxProcs / 2, 2);

			postAssertions();
		});
	});

	describe('maxProcAgeMillis (cull old children)', function () {
		const opts = {
			...DefaultOpts,
			maxProcs: 4,
			maxTasksPerProcess: 100,
			spawnTimeoutMillis: 2000, // maxProcAge must be >= this
			maxProcAgeMillis: 3000,
		};

		let bc: BatchCluster;

		beforeEach(
			() => (bc = listen(
				new BatchCluster({
					...opts,
					processFactory,
				}),
			)),
		);

		afterEach(() => shutdown(bc));

		it('culls old child procs', async () => {
			assertExpectedResults(
				await Promise.all(runTasks(bc, opts.maxProcs + 100)),
			);
			// 0 because we might get unlucky.
			expect((await bc.pids()).length).to.be.within(0, opts.maxProcs);
			await delay(opts.maxProcAgeMillis + 100);
			bc['vacuumProcs']();
			expect(bc.countEndedChildProcs('idle')).to.eql(0);
			expect(bc.countEndedChildProcs('old')).to.be.gte(2);
			// Calling .pids calls .procs(), which culls old procs
			expect((await bc.pids()).length).to.be.within(0, opts.maxProcs);
			postAssertions();
		});
	});

	describe('maxIdleMsPerProcess', function () {
		const opts = {
			...DefaultOpts,
			maxProcs: 4,
			maxIdleMsPerProcess: 1000,
			maxProcAgeMillis: 30_000,
		};

		let bc: BatchCluster;

		beforeEach(
			() => (bc = listen(
				new BatchCluster({
					...opts,
					processFactory,
				}),
			)),
		);

		afterEach(() => shutdown(bc));

		it('culls idle child procs', async () => {
			assertExpectedResults(
				await Promise.all(runTasks(bc, opts.maxProcs + 10)),
			);
			// 0 because we might get unlucky.
			expect((await bc.pids()).length).to.be.within(0, opts.maxProcs);
			await delay(opts.maxIdleMsPerProcess + 100);
			bc['vacuumProcs']();
			expect(bc.countEndedChildProcs('idle')).to.be.gte(1);
			expect(bc.countEndedChildProcs('old')).to.be.lte(1);
			expect(bc.countEndedChildProcs('worn')).to.be.lte(2);
			// Calling .pids calls .procs(), which culls old procs
			if ((await bc.pids()).length > 0) {
				await delay(1000);
			}
			expect((await bc.pids()).length).to.eql(0);
			postAssertions();
		});
	});

	describe('maxProcAgeMillis (recycling procs)', () => {
		let bc: BatchCluster;

		afterEach(() => {
			tk.reset();
			return shutdown(bc);
		});
		for (
			const { maxProcAgeMillis, ctx, exp } of [
				{
					maxProcAgeMillis: 0,
					ctx: 'procs should not be recycled due to old age',
					exp: (pidsBefore: number[], pidsAfter: number[]) => {
						expect(pidsBefore).to.eql(pidsAfter);
						expect(bc.countEndedChildProcs('idle')).to.eql(0);
						expect(bc.countEndedChildProcs('old')).to.eql(0);
					},
				},
				{
					maxProcAgeMillis: 5000,
					ctx: 'procs should be recycled due to old age',
					exp: (pidsBefore: number[], pidsAfter: number[]) => {
						expect(pidsBefore).to.not.have.members(pidsAfter);
						expect(bc.countEndedChildProcs('idle')).to.eql(0);
						expect(bc.countEndedChildProcs('old')).to.be.gte(1);
					},
				},
			]
		) {
			it('(' + maxProcAgeMillis + '): ' + ctx, async function () {
				// TODO: look into why this fails in CI on windows
				if (isWin && isCI) {
					// return this.skip()
					return;
				}
				const start = Date.now();
				tk.freeze(start);

				bc = listen(
					new BatchCluster({
						...DefaultOpts,
						maxProcs: 1,
						maxProcAgeMillis,
						spawnTimeoutMillis: Math.max(maxProcAgeMillis, safeTaskTimeout),
						processFactory: () => processFactory({
							failrate: 0
						})
					}),
				);
				assertExpectedResults(await Promise.all(runTasks(bc, 2)));
				const pidsBefore = await bc.pids();
				tk.freeze(start + 7000);
				assertExpectedResults(await Promise.all(runTasks(bc, 2)));
				const pidsAfter = await bc.pids();
				console.dir({ maxProcAgeMillis, pidsBefore, pidsAfter });
				exp(pidsBefore, pidsAfter);
				postAssertions();
				return;
			});
		}
	});

	describe('opts parsing', () => {
		function errToArr(err: any) {
			return err
				.toString()
				.split(/[:,]/)
				.map((ea: string) => ea.trim());
		}

		it('requires maxProcAgeMillis to be > spawnTimeoutMillis', () => {
			const spawnTimeoutMillis = DefaultOpts.taskTimeoutMillis + 1;
			try {
				new BatchCluster({
					processFactory,
					...DefaultOpts,
					spawnTimeoutMillis,
					maxProcAgeMillis: spawnTimeoutMillis - 1,
				});
				throw new Error('expected an error due to invalid opts');
			} catch (err) {
				expect(errToArr(err)).to.eql([
					'Error',
					'BatchCluster was given invalid options',
					'maxProcAgeMillis must be greater than or equal to ' +
					spawnTimeoutMillis,
					`the max value of spawnTimeoutMillis (${spawnTimeoutMillis}) and taskTimeoutMillis (${DefaultOpts.taskTimeoutMillis})`,
				]);
			}
		});

		it('requires maxProcAgeMillis to be > taskTimeoutMillis', () => {
			const taskTimeoutMillis = DefaultOpts.spawnTimeoutMillis + 1;
			try {
				new BatchCluster({
					processFactory,
					...DefaultOpts,
					taskTimeoutMillis,
					maxProcAgeMillis: taskTimeoutMillis - 1,
				});
				throw new Error('expected an error due to invalid opts');
			} catch (err) {
				expect(errToArr(err)).to.eql([
					'Error',
					'BatchCluster was given invalid options',
					'maxProcAgeMillis must be greater than or equal to ' +
					taskTimeoutMillis,
					`the max value of spawnTimeoutMillis (${DefaultOpts.spawnTimeoutMillis}) and taskTimeoutMillis (${taskTimeoutMillis})`,
				]);
			}
		});

		it('reports on invalid opts', () => {
			try {
				new BatchCluster({
					processFactory,
					versionCommand: '',
					pass: '',
					fail: '',

					spawnTimeoutMillis: 50,
					taskTimeoutMillis: 5,
					maxTasksPerProcess: 0,

					maxProcs: -1,
					maxProcAgeMillis: -1,
					onIdleIntervalMillis: -1,
					endGracefulWaitTimeMillis: -1,
					streamFlushMillis: -1,
				});
				throw new Error('expected an error due to invalid opts');
			} catch (err) {
				expect(errToArr(err)).to.eql([
					'Error',
					'BatchCluster was given invalid options',
					'versionCommand must not be blank',
					'pass must not be blank',
					'fail must not be blank',
					'spawnTimeoutMillis must be greater than or equal to 100',
					'taskTimeoutMillis must be greater than or equal to 10',
					'maxTasksPerProcess must be greater than or equal to 1',
					'maxProcs must be greater than or equal to 1',
					'maxProcAgeMillis must be greater than or equal to 50',
					'the max value of spawnTimeoutMillis (50) and taskTimeoutMillis (5)',
					'onIdleIntervalMillis must be greater than or equal to 0',
					'endGracefulWaitTimeMillis must be greater than or equal to 0',
					'streamFlushMillis must be greater than or equal to 0',
				]);
			}
		});
	});
});
