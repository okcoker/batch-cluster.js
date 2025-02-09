import child_process from "child_process"
import EventEmitter from "events"
import process from "process"
import timers from "timers"
import { filterInPlace } from "./Array"
import { BatchClusterEmitter, BatchClusterEvents } from "./BatchClusterEmitter"
import {
  AllOpts,
  BatchClusterOptions,
  verifyOptions,
} from "./BatchClusterOptions"
import { BatchProcess, WhyNotReady } from "./BatchProcess"
import { BatchProcessOptions } from "./BatchProcessOptions"
import { Deferred } from "./Deferred"
import { asError } from "./Error"
import { Logger } from "./Logger"
import { Mean } from "./Mean"
import { fromEntries, map } from "./Object"
import { Parser } from "./Parser"
import { Rate } from "./Rate"
import { Task } from "./Task"

export { BatchClusterOptions } from "./BatchClusterOptions"
export { Deferred } from "./Deferred"
export * from "./Logger"
export { SimpleParser } from "./Parser"
export { kill, pidExists, pids } from "./Pids"
export { Task } from "./Task"
export type {
  BatchProcessOptions,
  Parser,
  BatchClusterEvents,
  BatchClusterEmitter,
}

/**
 * These are required parameters for a given BatchCluster.
 */
export interface ChildProcessFactory {
  /**
   * Expected to be a simple call to execFile. Platform-specific code is the
   * responsibility of this thunk. Error handlers will be registered as
   * appropriate.
   */
  readonly processFactory: () =>
    | child_process.ChildProcess
    | Promise<child_process.ChildProcess>
}

export type ChildEndCountType = WhyNotReady | "tooMany"

/**
 * BatchCluster instances manage 0 or more homogeneous child processes, and
 * provide the main interface for enqueuing `Task`s via `enqueueTask`.
 *
 * Given the large number of configuration options, the constructor
 * receives a single options hash. The most important of these are the
 * `ChildProcessFactory`, which specifies the factory that creates
 * ChildProcess instances, and `BatchProcessOptions`, which specifies how
 * child tasks can be verified and shut down.
 */
export class BatchCluster {
  readonly #tasksPerProc: Mean = new Mean()
  readonly #logger: () => Logger
  readonly options: AllOpts
  readonly #procs: BatchProcess[] = []
  #lastSpawnedProcTime = 0
  #lastPidsCheckTime = Date.now()
  readonly #tasks: Task[] = []
  #onIdleInterval: NodeJS.Timer | undefined
  readonly #startErrorRate = new Rate()
  #spawnedProcs = 0
  #endPromise?: Deferred<void>
  #internalErrorCount = 0
  readonly #childEndCounts = new Map<ChildEndCountType, number>()
  readonly emitter = new EventEmitter() as BatchClusterEmitter

  constructor(
    opts: Partial<BatchClusterOptions> &
      BatchProcessOptions &
      ChildProcessFactory
  ) {
    this.options = verifyOptions({ ...opts, observer: this.emitter })

    this.on("internalError", (error) => {
      this.#logger().error("BatchCluster: INTERNAL ERROR: " + error)
      this.#internalErrorCount++
    })

    this.on("startError", (error) => {
      this.#logger().warn("BatchCluster.onStartError(): " + error)
      this.#startErrorRate.onEvent()
      if (
        this.#startErrorRate.eventsPerMinute >
        this.options.maxReasonableProcessFailuresPerMinute
      ) {
        this.emitter.emit(
          "endError",
          new Error(
            error +
              "(start errors/min: " +
              this.#startErrorRate.eventsPerMinute.toFixed(2) +
              ")"
          )
        )
        this.end()
      }
    })

    if (this.options.onIdleIntervalMillis > 0) {
      this.#onIdleInterval = timers.setInterval(
        () => this.onIdle(),
        this.options.onIdleIntervalMillis
      )
      this.#onIdleInterval.unref() // < don't prevent node from exiting
    }
    this.#logger = this.options.logger

    process.once("beforeExit", this.#beforeExitListener)
    process.once("exit", this.#exitListener)
  }

  /**
   * @see BatchClusterEvents
   */
  readonly on = this.emitter.on.bind(this.emitter)

  /**
   * @see BatchClusterEvents
   * @since v9.0.0
   */
  readonly off = this.emitter.off.bind(this.emitter)

  readonly #beforeExitListener = () => this.end(true)
  readonly #exitListener = () => this.end(false)

  get ended(): boolean {
    return this.#endPromise != null
  }

  /**
   * Shut down this instance, and all child processes.
   * @param gracefully should an attempt be made to finish in-flight tasks, or
   * should we force-kill child PIDs.
   */
  // NOT ASYNC so state transition happens immediately
  end(gracefully = true): Deferred<void> {
    if (this.#endPromise == null) {
      this.emitter.emit("beforeEnd")
      map(this.#onIdleInterval, timers.clearInterval)
      this.#onIdleInterval = undefined
      process.removeListener("beforeExit", this.#beforeExitListener)
      process.removeListener("exit", this.#exitListener)
      this.#endPromise = new Deferred<void>().observe(
        this.closeChildProcesses(gracefully)
          .catch((err) => {
            this.emitter.emit("endError", err)
          })
          .then(() => {
            this.emitter.emit("end")
          })
      )
    }

    return this.#endPromise
  }

  /**
   * Submits `task` for processing by a `BatchProcess` instance
   *
   * @return a Promise that is resolved or rejected once the task has been
   * attempted on an idle BatchProcess
   */
  enqueueTask<T>(task: Task<T>): Promise<T> {
    if (this.ended) {
      task.reject(
        new Error("BatchCluster has ended, cannot enqueue " + task.command)
      )
    }
    this.#tasks.push(task)
    setImmediate(() => this.onIdle())
    return task.promise.finally(() => this.onIdle())
  }

  /**
   * @return true if all previously-enqueued tasks have settled
   */
  get isIdle(): boolean {
    return this.pendingTaskCount === 0 && this.busyProcCount === 0
  }

  /**
   * @return the number of pending tasks
   */
  get pendingTaskCount(): number {
    return this.#tasks.length
  }

  /**
   * @returns {number} the mean number of tasks completed by child processes
   */
  get meanTasksPerProc(): number {
    return this.#tasksPerProc.mean
  }

  /**
   * @return the total number of child processes created by this instance
   */
  get spawnedProcCount(): number {
    return this.#spawnedProcs
  }

  /**
   * @return the current number of spawned child processes. Some (or all) may be idle.
   */
  get procCount(): number {
    return this.#procs.length
  }

  /**
   * @return the current number of child processes currently servicing tasks
   */
  get busyProcCount(): number {
    return this.#procs.filter(
      // don't count procs that are starting up as "busy":
      (ea) => ea.taskCount > 0 && !ea.exited && !ea.idle
    ).length
  }

  /**
   * @return the current pending Tasks (mostly for testing)
   */
  get pendingTasks() {
    return this.#tasks
  }

  /**
   * @return the current running Tasks (mostly for testing)
   */
  get currentTasks(): Task[] {
    return this.#procs
      .map((ea) => ea.currentTask)
      .filter((ea) => ea != null) as Task[]
  }

  /**
   * For integration tests:
   */
  get internalErrorCount(): number {
    return this.#internalErrorCount
  }

  /**
   * Verify that each BatchProcess PID is actually alive.
   *
   * @return the spawned PIDs that are still in the process table.
   */
  async pids(): Promise<number[]> {
    const arr: number[] = []
    for (const proc of [...this.#procs]) {
      if (proc != null && !proc.exited && (await proc.running())) {
        arr.push(proc.pid)
      }
    }
    return arr
  }

  /**
   * Get ended process counts (used for tests)
   */
  countEndedChildProcs(why: ChildEndCountType): number {
    return this.#childEndCounts.get(why) ?? 0
  }

  get childEndCounts(): { [key in NonNullable<ChildEndCountType>]: number } {
    return fromEntries([...this.#childEndCounts.entries()])
  }

  /**
   * Shut down any currently-running child processes. New child processes will
   * be started automatically to handle new tasks.
   */
  async closeChildProcesses(gracefully = true) {
    const procs = [...this.#procs]
    this.#procs.length = 0
    for (const proc of procs) {
      try {
        await proc.end(gracefully, "BatchCluster.closeChildProcesses()")
      } catch {
        // ignore: make sure all procs are ended
      }
    }
  }

  /**
   * Reset the maximum number of active child processes to `maxProcs`. Note that
   * this is handled gracefully: child processes are only reduced as tasks are
   * completed.
   */
  setMaxProcs(maxProcs: number) {
    this.options.maxProcs = maxProcs
    // we may now be able to handle an enqueued task. Vacuum pids and see:
    this.onIdle()
  }

  // NOT ASYNC: updates internal state:
  private onIdle() {
    this.vacuumProcs()
    while (this.#execNextTask()) {
      //
    }
    this.#maybeLaunchNewChild()
  }

  #maybeCheckPids() {
    if (
      this.options.pidCheckIntervalMillis > 0 &&
      this.#lastPidsCheckTime + this.options.pidCheckIntervalMillis < Date.now()
    ) {
      this.#lastPidsCheckTime = Date.now()
      void this.pids()
    }
  }

  /**
   * Run maintenance on currently spawned child processes. This method is
   * normally invoked automatically as tasks are enqueued and processed.
   */
  // NOT ASYNC: updates internal state. only exported for tests.
  vacuumProcs() {
    this.#maybeCheckPids()
    filterInPlace(this.#procs, (proc) => {
      // Don't bother running procs:
      if (!proc.ending && !proc.idle) return true

      const why =
        this.#procs.length > this.options.maxProcs
          ? "tooMany"
          : proc.whyNotHealthy // NOT whyNotReady: we don't care about busy procs
      if (why != null) {
        this.#childEndCounts.set(why, 1 + this.countEndedChildProcs(why))
        void proc.end(true, why)
      }
      return why == null
    })
  }

  // NOT ASYNC: updates internal state.
  #execNextTask(): boolean {
    if (this.#tasks.length === 0 || this.ended) return false
    const readyProc = this.#procs.find((ea) => ea.ready)
    // no procs are idle and healthy :(
    if (readyProc == null) {
      return false
    }

    const task = this.#tasks.shift()
    if (task == null) {
      this.emitter.emit("internalError", new Error("unexpected null task"))
      return false
    }

    const submitted = readyProc.execTask(task)
    if (!submitted) {
      // This isn't an internal error: the proc may have needed to run a health
      // check. Let's reschedule the task and try again:
      this.#tasks.push(task)
      // We don't want to return false here (it'll stop the onIdle loop) unless
      // we actually can't submit the task:
      return this.#execNextTask()
    }
    return submitted
  }

  // NOT ASYNC: updates internal state.
  #maybeLaunchNewChild() {
    if (
      !this.ended &&
      this.#tasks.length > 0 &&
      this.#procs.length < this.options.maxProcs &&
      this.#lastSpawnedProcTime + this.options.minDelayBetweenSpawnMillis <=
        Date.now()
    ) {
      // prevent multiple concurrent spawns:
      this.#lastSpawnedProcTime = Date.now()
      void this.#spawnChild()
    }
  }

  // must only be called by .#maybeLaunchNewChild()
  async #spawnChild(): Promise<BatchProcess | undefined> {
    if (this.ended) return

    try {
      const child = await this.options.processFactory()
      const pid = child.pid
      if (pid == null) {
        this.emitter.emit("childExit", child)
        return
      }
      const proc = new BatchProcess(child, this.options)

      if (this.ended) {
        void proc.end(false, "ended")
        return
      }

      // Bookkeeping (even if we need to shut down `proc`):
      this.#spawnedProcs++
      this.emitter.emit("childStart", child)
      void proc.exitPromise.then(() => {
        this.#tasksPerProc.push(proc.taskCount)
        this.emitter.emit("childExit", child)
      })

      // Did we call _mayLaunchNewChild() a couple times in parallel?
      if (this.#procs.length >= this.options.maxProcs) {
        // only vacuum if we're at the limit
        this.vacuumProcs()
      }
      if (this.#procs.length >= this.options.maxProcs) {
        void proc.end(false, "maxProcs")
        return
      } else {
        this.#procs.push(proc)
        return proc
      }
    } catch (err) {
      this.emitter.emit("startError", asError(err))
      return
    }
  }
}
