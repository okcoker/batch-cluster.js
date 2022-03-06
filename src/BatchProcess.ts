import { delay, until } from './Async.ts';
import { Deferred } from './Deferred.ts';
import { cleanError, tryEach } from './Error.ts';
import { setImmediate } from '../deps.ts';
import { InternalBatchProcessOptions } from './InternalBatchProcessOptions.ts';
import { Logger } from './Logger.ts';
import { map } from './Object.ts';
import { SimpleParser } from './Parser.ts';
import { kill, pidExists } from './Pids.ts';
import { blank, ensureSuffix } from './String.ts';
import { Task } from './Task.ts';

export type WhyNotReady = BatchProcess['whyNotHealthy'];

/**
 * BatchProcess manages the care and feeding of a single child process.
 */
export class BatchProcess {
    readonly name: string;
    readonly pid: number;
    readonly start = Date.now();
    #lastHealthCheck = Date.now();
    #healthCheckFailures = 0;

    readonly startupTaskId: number;
    readonly #logger: () => Logger;
    #lastJobFinshedAt = Date.now();

    // Only set to true when `proc.pid` is no longer in the process table.
    #dead = false;

    failedTaskCount = 0;

    #taskCount = -1; // don't count the startupTask

    #ending = false;
    /**
     * Supports non-polling notification of process exit
     */
    readonly #resolvedOnExit = new Deferred<void>();
    /**
     * Should be undefined if this instance is not currently processing a task.
     */
    #currentTask: Task | undefined;
    #currentTaskTimeout: number | undefined;

    #stdoutTimer: number | undefined;
    #stderrTimer: number | undefined;

    constructor(
        readonly proc: Deno.Process,
        readonly opts: InternalBatchProcessOptions,
    ) {
        this.name = 'BatchProcess(' + proc.pid + ')';
        this.#logger = opts.logger;
        // don't let node count the child processes as a reason to stay alive

        // @todo follow up on this to see if its needed
        // https://github.com/denoland/deno/pull/12889/files
        // this.proc.unref()

        if (!proc.pid) {
            throw new Error(
                'BatchProcess.constructor: child process pid is null',
            );
        }
        this.pid = proc.pid;

        const stdin = this.proc.stdin;
        if (!stdin) throw new Error('Given proc had no stdin');

        const stdout = this.proc.stdout;
        if (!stdout) throw new Error('Given proc had no stdout');

        const startupTask = new Task(opts.versionCommand, SimpleParser);
        this.startupTaskId = startupTask.taskId;

        if (!this.execTask(startupTask)) {
            // This could also be considered a "start error", but if it's just an
            // internal bug and the process starts, don't veto because there's a bug:
            this.opts.observer.emit(
                'internalError',
                new Error(this.name + ' startup task was not submitted'),
            );
        }
    }

    get currentTask(): Task | undefined {
        return this.#currentTask;
    }
    get taskCount(): number {
        return this.#taskCount;
    }
    /**
     * @return true if `this.end()` has been requested or the child process has
     * exited.
     */
    get ending(): boolean {
        return this.#ending;
    }
    /**
     * @return true if the child process has exited and is no longer in the
     * process table.
     */
    get exited(): boolean {
        return this.#resolvedOnExit.settled;
    }
    get exitPromise(): Promise<void> {
        return this.#resolvedOnExit.promise;
    }

    get whyNotHealthy() {
        if (this.exited) {
            return 'dead';
        }

        if (this.#ending) {
            return 'ending';
        }

        if (this.#healthCheckFailures > 0) {
            return 'unhealthy';
        }

        if (this.proc.stdin === null) {
            return 'closed';
        }

        if (
            this.opts.maxTasksPerProcess > 0 &&
            this.taskCount >= this.opts.maxTasksPerProcess
        ) {
            return 'worn';
        }

        if (
            this.opts.maxIdleMsPerProcess > 0 &&
            this.idleMs > this.opts.maxIdleMsPerProcess
        ) {
            return 'idle';
        }

        if (
            this.opts.maxFailedTasksPerProcess > 0 &&
            this.failedTaskCount >= this.opts.maxFailedTasksPerProcess
        ) {
            return 'broken';
        }

        if (
            this.opts.maxProcAgeMillis > 0 &&
            this.start + this.opts.maxProcAgeMillis < Date.now()
        ) {
            return 'old';
        }

        if (
            (this.opts.taskTimeoutMillis > 0 && this.#currentTask?.runtimeMs) ??
                0 > this.opts.taskTimeoutMillis
        ) {
            return 'timeout';
        }

        return undefined;
    }

    /**
     * @return true if the process doesn't need to be recycled.
     */
    get healthy(): boolean {
        return !this.whyNotHealthy;
    }

    get whyNotReady() {
        return !this.idle ? 'busy' : this.whyNotHealthy;
    }

    get ready(): boolean {
        return !this.whyNotReady;
    }

    get idle(): boolean {
        return !this.#currentTask;
    }

    get idleMs(): number {
        return this.idle ? Date.now() - this.#lastJobFinshedAt : -1;
    }

    /**
     * @return true if the child process is in the process table
     */
    async running(): Promise<boolean> {
        if (this.#dead) {
            // this.dead is only set if the process table has said we're dead.
            return false;
        }

        const alive = await pidExists(this.pid);
        if (!alive) {
            // once a PID leaves the process table, it's gone for good:
            this.#dead = true;
            this.#ending = true;
            this.#resolvedOnExit.resolve();
        }
        return alive;
    }

    notRunning(): Promise<boolean> {
        return this.running().then((ea) => !ea);
    }

    /**
     * @return {boolean} true if `this.end()` has been requested or the child
     * process has exited.
     */
    async ended(): Promise<boolean> {
        return this.#dead || (await this.notRunning());
    }

    notEnded(): Promise<boolean> {
        return this.ended().then((ea) => !ea);
    }

    // This must not be async, or new instances aren't started as busy (until the
    // startup task is complete)
    execTask(task: Task): boolean {
        this.#logger().debug(`${this.name} executing task`);
        const why = this.whyNotReady;
        if (why) {
            this.#logger().debug(`${this.name} execTask() not ready: ${why}`);
            return false;
        }

        const lastCheckDelta = Date.now() - this.#lastHealthCheck;
        if (
            this.opts.healthCheckCommand != null &&
            this.opts.healthCheckIntervalMillis > 0 &&
            lastCheckDelta >
                this.opts.healthCheckIntervalMillis
        ) {
            this.#lastHealthCheck = Date.now();
            const t = new Task(this.opts.healthCheckCommand, SimpleParser);
            t.promise
                .catch((err) => {
                    this.#logger().debug(
                        `${this.name} execTask#: health check failed ${err}`,
                    );
                    this.opts.observer.emit('healthCheckError', err, this);
                    this.#healthCheckFailures++;
                })
                .finally(() => {
                    this.#lastHealthCheck = Date.now();
                });
            this.#logger().debug(`${this.name} Running healthcheck`);
            this.#execTask(t);
            return false;
        }

        this.#logger().debug(`${this.name} running ${task}`);
        return this.#execTask(task);
    }

    #listenForStdio() {
        clearTimeout(this.#stdoutTimer);
        clearTimeout(this.#stderrTimer);

        void this.proc.status().then((status) => {
			clearTimeout(this.#stdoutTimer);
			clearTimeout(this.#stderrTimer);

			if (status.code !== 0) {
				this.#logger().debug(`${this.name} #onError ${status}`);
				this.#onError(
					'proc status err',
					new Error(
						`proc.error(${this.pid}) code: ${status.code} ${
							status.signal ? `status: ${status.signal}` : ''
						}`,
					),
				);
				return;
			}

			this.#logger().debug(
				`${this.name} #onExit ${JSON.stringify(status)}`,
			);
			this.#onExit('exit');
        });

        // Listening for stderr and stdout chunks separately
        // because we don't want one io to await/hold up the other
        const listenStdout = async () => {
            try {
				this.#logger().debug(`${this.name} listening stdout`);

                const buffered = new Uint8Array(this.opts.stdoutBuffer ?? 512);
                const length = await this.proc.stdout?.read(buffered);

                if (length) {
                    const output = new TextDecoder().decode(
                        buffered.slice(0, length),
                    );
                    this.#logger().debug(
                        `${this.name} ${
                            this.#currentTask?.toString()
                        } stdout: ${output}`,
                    );
                    this.#onStdout(output);
                }
            } catch (err) {
                if (this.#ending) {
                    clearTimeout(this.#stdoutTimer);
                    return;
                }

                this.#logger().debug(`${this.name} listen err ${err}`);
                this.#onError(
                    'stdout.error',
                    new Error(`proc.error(${this.pid}) ${err}`),
                );
                return;
            }

            this.#stdoutTimer = setTimeout(listenStdout, 500);
        };

        const listenStderr = async () => {
            try {
				this.#logger().debug(`${this.name} listening stderr`);

                const buffered = new Uint8Array(this.opts.stderrBuffer ?? 512);
                const length = await this.proc.stderr?.read(buffered);

                if (length) {
                    const output = new TextDecoder().decode(
                        buffered.slice(0, length),
                    );
                    this.#logger().debug(
                        `${this.name} ${
                            this.#currentTask?.toString()
                        } stderr: ${output}`,
                    );
                    this.#onStderr(output);
                }
            } catch (err) {
                if (this.#ending) {
                    clearTimeout(this.#stderrTimer);
                    return;
                }

                this.#logger().debug(`${this.name} listen err ${err}`);
                this.#onError(
                    'stderr.error',
                    new Error(`proc.error(${this.pid}) ${err}`),
                );
                return;
            }

            this.#stderrTimer = setTimeout(listenStderr, 500);
        };

        listenStdout();
        listenStderr();
    }

    #execTask(task: Task): boolean {
        if (this.#ending) {
            this.#logger().debug(`${this.name} this.#ending`);
            return false;
        }

        this.#taskCount++;
        this.#currentTask = task;
        const cmd = ensureSuffix(task.command, '\n');
        const isStartupTask = task.taskId === this.startupTaskId;
        this.#logger().debug(
            `${this.name} isStartupTask ${isStartupTask} ${task}`,
        );
        const timeoutMs = isStartupTask
            ? this.opts.spawnTimeoutMillis
            : this.opts.taskTimeoutMillis;
        if (timeoutMs > 0) {
            // console.log(`${this.name} setting timer ${task.toString()}`);
            // logger().trace(this.name + ".execTask(): scheduling timeout", {
            //   command: task.command,
            //   timeoutMs,
            //   pid: this.pid
            // })
            this.#currentTaskTimeout = setTimeout(
                () => this.#onTimeout(task, timeoutMs),
                timeoutMs,
            );
        }
        // CAREFUL! If you add a .catch or .finally, the pipeline can emit unhandled
        // rejections:
        void task.promise.then(
            () => {
                this.#clearCurrentTask(task);

                if (!isStartupTask) {
                    // console.log(`${this.name} task.prom.then ${task.toString()} ${task.runtimeMs}`);
                    this.#logger().debug(
                        `${this.name} ${task.toString()} runtime: ${task.runtimeMs}`,
                    );
                    this.opts.observer.emit('taskResolved', task, this);
                }
            },
            (err) => {
                this.#clearCurrentTask(task);
                // console.log(`${this.name} TASK.prom.err ${task.toString()} runtime ${task.runtimeMs} err ${err}`);
                if (isStartupTask) {
                    this.opts.observer.emit('startError', err);
                } else {
                    this.opts.observer.emit('taskError', err, task, this);
                }
            },
        );

        try {
            this.#logger().debug(
                `${this.name} ${task.toString()} starting task`,
            );
            task.onStart(this.opts);
            const stdin = this.proc.stdin;

            if (stdin === null) {
                this.#logger().debug(`${this.name} stdin null`);
                task.reject(new Error('proc.stdin unexpectedly closed'));
                return false;
            }

            this.#listenForStdio();
            this.#logger().debug(
                `${this.name} output length write ${task.toString()} ${cmd}`,
            );
            void stdin.write(new TextEncoder().encode(cmd)).then((length) => {
                this.#logger().debug(
                    `${this.name} ${task.toString()} wrote bytes ${length}`,
                );
            }).catch((err) => {
                this.#logger().debug(`${this.name} no write`);
                task.reject(err);
            });

            return true;
        } catch (err: any) {
            // child process went away. We should too.
            this.#logger().debug(`${this.name} child proc went away ${err}`);
            this.end(false, 'proc.stdin.write(cmd)');
            return false;
        }
    }

    /**
     * End this child process.
     *
     * @param gracefully Wait for any current task to be resolved or rejected before shutting down the child process.
     * @param source who called end() (used for logging)
     * @return Promise that will be resolved when the process has completed. Subsequent calls to end() will ignore the parameters and return the first endPromise.
     */
    // NOT ASYNC! needs to change state immediately.
    end(gracefully = true, source: string) {
        this.#logger().debug(`${this.name} Ending from ${source}`);
        if (this.#ending) {
            return Promise.resolve();
        }
        this.#ending = true;
        return this.#end(gracefully, source);
    }

    // NOTE: Must only be invoked by this.end(), and only expected to be invoked
    // once per instance.
    async #end(gracefully = true, source: string): Promise<void> {
        const lastTask = this.#currentTask;
        this.#clearCurrentTask();

        // NOTE: We wait on all tasks (even startup tasks) so we can assert that
        // BatchCluster is idle (and this proc is idle) when the end promise is
        // resolved.

        // NOTE: holy crap there are a lot of notes here.

        if (lastTask) {
            try {
                // Let's wait for streams to flush, as that may actually allow the task
                // to complete successfully. Let's not wait forever, though.
                await Promise.race([
                    lastTask.promise,
                    delay(gracefully ? 2000 : 250),
                ]);
            } catch {
                //
            }
            if (lastTask.pending) {
                lastTask.reject(
                    new Error(
                        `end() called before task completed (${
                            JSON.stringify({
                                gracefully,
                                source,
                            })
                        })`,
                    ),
                );
            }
        }

        const cmd = map(this.opts.exitCommand, (ea) => ensureSuffix(ea, '\n'));

        this.#logger().debug(`${this.name} proc cleanup`);
        // proc cleanup:
        await tryEach([
            async () => {
                if (cmd) {
                    this.#logger().debug(
                        `${this.name} running exit command ${cmd}`,
                    );
                }
                await this.proc.stdin!.write(new TextEncoder().encode(cmd));
                this.#logger().debug(`${this.name} closing stdin`);
                this.proc.stdin!.close();
            },
            async () => {
                this.#logger().debug(`${this.name} getting last proc status`);
                await this.proc.status();
            },
            () => {
                this.#logger().debug(`${this.name} closing stdout`);
                this.proc.stdout!.close();
            },
            () => {
                this.#logger().debug(`${this.name} closing stderr`);
                this.proc.stderr!.close();
            },
            () => {
                this.#logger().debug(`${this.name} closing proc`);
                this.proc.close();
            },
        ]);

        if (
            this.opts.cleanupChildProcs &&
            gracefully &&
            this.opts.endGracefulWaitTimeMillis > 0 &&
            (await this.running())
        ) {
            // Wait for the end command to take effect:
            await this.#awaitNotRunning(
                this.opts.endGracefulWaitTimeMillis / 2,
            );
            // If it's still running, send the pid a signal:
            if ((await this.running()) && this.proc.pid) {
                await kill(this.proc.pid);
            }
            // Wait for the signal handler to work:
            await this.#awaitNotRunning(
                this.opts.endGracefulWaitTimeMillis / 2,
            );
        }

        if (
            this.opts.cleanupChildProcs &&
            this.proc.pid &&
            (await this.running())
        ) {
            this.#logger().warn(
                this.name + '.end(): force-killing still-running child.',
            );
            await kill(this.proc.pid, true);
        }

        // Make sure async procs are cleaned out
        // Noticed some leaking async ops within exiftool tests
        clearTimeout(this.#stderrTimer);
        clearTimeout(this.#stdoutTimer);
        return this.#resolvedOnExit;
    }

    #awaitNotRunning(timeout: number) {
        return until(() => this.notRunning(), timeout);
    }

    #onTimeout(task: Task, timeoutMs: number): void {
        if (task.pending) {
            this.opts.observer.emit('taskTimeout', timeoutMs, task, this);
            this.#onError(
                'timeout',
                new Error('waited ' + timeoutMs + 'ms'),
                task,
            );
        }
    }

    #onError(source: string, _error: Error, task?: Task) {
        this.#logger().debug(`${this.name} #onError`, {
            source,
            _error,
            task,
        });

        if (this.#ending) {
            // We're ending already, so don't propagate the error.
            // This is expected due to race conditions stdin EPIPE and process shutdown.
            this.#logger().debug(
                this.name + '.onError() post-end (expected and not propagated)',
                {
                    source,
                    _error,
                    task,
                },
            );
            return;
        }
        if (!task) {
            task = this.#currentTask;
        }
        const error = new Error(source + ': ' + cleanError(_error.message));
        this.#logger().warn(this.name + '.onError()', {
            source,
            task: map(task, (t) => t.command),
            error,
        });

        if (_error.stack) {
            // Error stacks, if set, will not be redefined from a rethrow:
            error.stack = cleanError(_error.stack);
        }

        // clear the task before ending so the onExit from end() doesn't retry the task:
        this.#clearCurrentTask();
        void this.end(false, 'onError(' + source + ')');

        if (task && this.taskCount === 1) {
            this.#logger().warn(
                this.name + '.onError(): startup task failed: ' + error,
            );
            this.opts.observer.emit('startError', error);
        }

        if (task) {
            if (task.pending) {
                task.reject(error);
            } else {
                this.opts.observer.emit(
                    'internalError',
                    new Error(
                        `${this.name}.onError(${error}) cannot reject already-fulfilled task.`,
                    ),
                );
            }
        }
    }

    #onExit(source: string) {
        this.#resolvedOnExit.resolve();
        // no need to be graceful, it's just for bookkeeping:
        return this.end(false, 'onExit(' + source + ')');
    }

    #onStderr(data: string) {
        if (blank(data)) return;

        this.#logger().debug(`${this.name} #onStderr`);

        this.#logger().info('onStderr(' + this.pid + '):' + data);

        const task = this.#currentTask;

        if (task && task.pending) {
            this.#logger().debug(`${this.name} task pending stderr`);
            task.onStderr(data);
        } else if (!this.#ending) {
            this.end(false, 'onStderr (no current task)');
            // If we're ending and there isn't a task, don't worry about it.
            // Otherwise:
            this.opts.observer.emit(
                'internalError',
                new Error(
                    'onStderr(' +
                        String(data).trim() +
                        ') no pending currentTask (task: ' +
                        task +
                        ')',
                ),
            );
        }
    }

    #onStdout(data: string) {
        // logger().debug("onStdout(" + this.pid + "):" + data)
        const task = this.#currentTask;

        this.#logger().debug(
            `${this.name} #onStdout ${task?.toString()} pending ${task
                ?.pending}`,
        );
        if (task && task.pending) {
            this.opts.observer.emit('taskData', data, task, this);
            task.onStdout(data);
        } else if (!this.#ending) {
            this.end(false, 'onStdout (no current task)');
            // If we're ending and there isn't a task, don't worry about it.
            // Otherwise:
            this.opts.observer.emit(
                'internalError',
                new Error(
                    'onStdout(' + data + ') no pending currentTask (task: ' +
                        task + ')',
                ),
            );
        }
    }

    #clearCurrentTask(task?: Task) {
        // console.log(this.pid, 'clearing attempt task', task?.toString(), 'current task', this.#currentTask?.toString());
        setImmediate(() => this.opts.observer.emit('idle'));
        if (task && task.taskId !== this.#currentTask?.taskId) return;
        // console.log(`${this.name} ${(task ?? this.#currentTask)?.toString()} clearing timeout success`);
        this.#logger().debug(
            `${this.name} clearing current task ${
                (task ?? this.#currentTask)?.toString() || ''
            }`,
        );
        clearTimeout(this.#currentTaskTimeout);
        this.#currentTaskTimeout = undefined;
        this.#currentTask = undefined;
        this.#lastJobFinshedAt = Date.now();
    }
}
