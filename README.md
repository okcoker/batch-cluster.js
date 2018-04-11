# batch-cluster

**Support external batch-mode tools within Node.js.**

[![npm version](https://badge.fury.io/js/batch-cluster.svg)](https://badge.fury.io/js/batch-cluster)
[![Build status](https://travis-ci.org/mceachen/batch-cluster.js.svg?branch=master)](https://travis-ci.org/mceachen/batch-cluster.js)
[![Build status](https://ci.appveyor.com/api/projects/status/4564x6lvc8s6a55l/branch/master?svg=true)](https://ci.appveyor.com/project/mceachen/batch-cluster-js/branch/master)

Many command line tools, like
[ExifTool](https://sno.phy.queensu.ca/~phil/exiftool/) and
[GraphicsMagick](http://www.graphicsmagick.org/), support running in a "batch
mode" that accept commands provided through stdin and results through stdout.
As these tools can be fairly large, spinning them up can be expensive
(especially on Windows).

This module expedites these commands, or "Tasks," by managing a cluster of
these "batch" processes, feeding tasks to idle processes, retrying tasks when
the tool crashes, and preventing memory leaks by restarting tasks after
performing a given number of tasks or after a given set of time has elapsed.

This package powers
[exiftool-vendored](https://github.com/mceachen/exiftool-vendored.js), whose
source you can examine as an example consumer.

## Installation

Depending on your yarn/npm preference:

```bash
$ yarn add batch-cluster
# or
$ npm install --save batch-cluster
```

## Usage

The child process must use `stdin` and `stdout` for control/response.
BatchCluster will ensure a given process is only given one task at a time.

_If these links are broken, use <https://batch-cluster.js.org/>_

1.  Create a singleton instance of [BatchCluster](/classes/_batchcluster_.batchcluster.html).

    Note the
    [constructor options](/classes/_batchcluster_.batchcluster.html#constructor) takes a union type of

    * [ChildProcessFactory](/interfaces/_batchcluster_.childprocessfactory.html) and
    * [BatchProcessOptions](/interfaces/_batchcluster_.batchprocessoptions.html), both of which have no
      defaults, and
    * [BatchClusterOptions](/classes/_batchcluster_.batchclusteroptions.html), which has defaults that may
      or may not be relevant to your application.

1.  The [default](/modules/_logger_.consolelogger.html) logger writes warning
    and error messages to `console.warn` and `console.error`. You can change
    this to your logger by using
    [setLogger](/modules/_logger_.html#setlogger).

1.  Implement the [Parser](/modules/_task_.html#parser) class to parse results from your child
    process.

1.  Construct a [Task](/classes/_task_.task.html) with the desired command and
    the parser you built in the previous step, and submit it to your
    BatchCluster singleton's
    [enqueueTask](/classes/_batchcluster_.batchcluster.html#enqueuetask)
    method.

See
[src/test.ts](https://github.com/mceachen/batch-cluster.js/blob/master/src/test.ts)
for an example child process. Note that the script is *designed* to be flaky
on order to test BatchCluster's retry and error handling code.

## Versioning

### The `MAJOR` or `API` version is incremented for

* 💔 Non-backwards-compatible API changes

### The `MINOR` or `UPDATE` version is incremented for

* ✨ Backwards-compatible features

### The `PATCH` version is incremented for

* 🐞 Backwards-compatible bug fixes
* 📦 Minor packaging changes

## Changelog

### v1.11.0

* ✨ Added new `BatchClusterObserver` for error and lifecycle monitoring
* 📦 Added a number of additional logging calls

### v1.10.0

* 🐞 Explicitly use `timers.setInterval`. May address [this
  issue](https://stackoverflow.com/questions/48961238/electron-setinterval-implementation-difference-between-chrome-and-node).
  Thanks for the PR, [Tim Fish](https://github.com/timfish)!

### v1.9.1

* 📦 Changed `BatchProcess.end()` to use `until()` rather than `Promise.race`,
  and always use `kill(pid, forced)` after waiting the shutdown grace period
  to prevent child process leaks.

### v1.9.0

* ✨ New `Logger.setLogger()` for debug, info, warning, and errors. `debug` and
  `info` defaults to Node's
  [debuglog](https://nodejs.org/api/util.html#util_util_debuglog_section),
  `warn` and `error` default to `console.warn` and `console.error`,
  respectively.
* 📦 docs generated by [typedoc](http://typedoc.org/)
* 📦 Upgraded dependencies (including TypeScript 2.7, which has more strict
  verifications)
* 📦 Removed tslint, as `tsc` provides good lint coverage now
* 📦 The code is now [prettier](https://github.com/prettier/prettier)
* 🐞 `delay` now allows
  [unref](https://nodejs.org/api/timers.html#timers_timeout_unref)ing the
  timer, which, in certain circumstances, could prevent node processes from
  exiting gracefully until their timeouts expired

### v1.8.0

* ✨ onIdle now runs as many tasks as it can, rather than just one. This should
  provide higher throughput.
* 🐞 Removed stderr emit on race condition between onIdle and execTask. The
  error condition was already handled appropriately--no need to console.error.

### v1.7.0

* 📦 Exported `kill()` and `running()` from `BatchProcess`

### v1.6.1

* 📦 De-flaked some tests on mac, and added Node 8 to the build matrix.

### v1.6.0

* ✨ Processes are forcefully shut down with `taskkill` on windows and `kill -9`
  on other unix-like platforms if they don't terminate after sending the
  `exitCommand`, closing `stdin`, and sending the proc a `SIGTERM`. Added a test
  harness to exercise.
* 📦 Upgrade to TypeScript 2.6.1
* 🐞 `mocha` tests don't require the `--exit` hack anymore 🎉

### v1.5.0

* ✨ `.running()` works correctly for PIDs with different owners now.
* 📦 `yarn upgrade --latest`

### v1.4.2

* 📦 Ran code through `prettier` and delinted
* 📦 Massaged test assertions to pass through slower CI systems

### v1.4.1

* 📦 Replaced an errant `console.log` with a call to `log`.

### v1.4.0

* 🐞 Discovered `maxProcs` wasn't always utilized by `onIdle`, which meant in
  certain circumstances, only 1 child process would be servicing pending
  requests. Added breaking tests and fixed impl.

### v1.3.0

* 📦 Added tests to verify that the `kill(0)` calls to verify the child
  processes are still running work across different node version and OSes
* 📦 Removed unused methods in `BatchProcess` (whose API should not be accessed
  directly by consumers, so the major version remains at 1)
* 📦 Switched to yarn and upgraded dependencies

### v1.2.0

* ✨ Added a configurable cleanup signal to ensure child processes shut down on
  `.end()`
* 📦 Moved child process management from `BatchCluster` to `BatchProcess`
* ✨ More test coverage around batch process concurrency, reuse, flaky task
  retries, and proper process shutdown

### v1.1.0

* ✨ `BatchCluster` now has a force-shutdown `exit` handler to accompany the
  graceful-shutdown `beforeExit` handler. For reference, from the
  [Node docs](https://nodejs.org/api/process.html#process_event_beforeexit):

> The 'beforeExit' event is not emitted for conditions causing explicit
> termination, such as calling process.exit() or uncaught exceptions.

* ✨ Remove `Rate`'s time decay in the interests of simplicity

### v1.0.0

* ✨ Integration tests now throw deterministically random errors to simulate
  flaky child procs, and ensure retries and disaster recovery work as expected.
* ✨ If the `processFactory` or `versionCommand` fails more often than a given
  rate, `BatchCluster` will shut down and raise exceptions to subsequent
  `enqueueTask` callers, rather than try forever to spin up processes that are
  most likely misconfigured.
* ✨ Given the proliferation of construction options, those options are now
  sanity-checked at construction time, and an error will be raised whose message
  contains all incorrect option values.

### v0.0.2

* ✨ Added support and explicit tests for
  [CR LF, CR, and LF](https://en.wikipedia.org/wiki/Newline) encoded streams
  from exec'ed processes
* ✨ child processes are ended after `maxProcAgeMillis`, and restarted as needed
* 🐞 `BatchCluster` now practices good listener hygene for `process.beforeExit`

### v0.0.1

* ✨ Extracted implementation and tests from
  [exiftool-vendored](https://github.com/mceachen/exiftool-vendored.js)
