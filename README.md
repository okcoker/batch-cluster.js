# batch-cluster

**Efficient, concurrent work via batch-mode command-line tools from within Node.js.**

This is a Deno fork of [batch-cluster](https://github.com/photostructure/batch-cluster.js)


## Testing

```
deno test --allow-all --unstable src/*.spec.ts
```
## Notes

- Child processes aren't event emitters in Deno
- Calling `SIGKILL` on a process won't actually kill the pid until you check `process.status()` (see tests)
- Updated `Harness` class in tests to accept process env as an argument. This removes the need for global values that might be shared if tests run in parallel
- Listening for signals inside the subprocess (`ie Deno.addSignalListener("SIGINT", handler)`) started by `Deno.run()` fail which seem to differ from Node's `child_process`.
