import { map } from './Object.ts';
import { isWin } from './Platform.ts';

function safePid(pid: number) {
	if (typeof pid !== 'number' || pid < 0) {
		throw new Error('invalid pid: ' + JSON.stringify(pid));
	} else {
		return Math.floor(pid).toString();
	}
}

/*

Windows 10:

>tasklist /NH /FO "CSV" /FI "PID eq 15524"
INFO: No tasks are running which match the specified criteria.

>tasklist /NH /FO "CSV" /FI "PID eq 11968"
"bash.exe","11968","Console","1","5,340 K"

Linux:

$ ps -p 20242
  PID TTY          TIME CMD
20242 pts/3    00:00:00 bash

Mac:

$ ps -p 32183
  PID TTY           TIME CMD
32183 ttys001    0:00.10 /bin/bash -l

*/

/**
 * @param {number} pid process id. Required.
 * @returns {Promise<boolean>} true if the given process id is in the local
 * process table. The PID may be paused or a zombie, though.
 */
export async function pidExists(
	pid: number | null | undefined,
): Promise<boolean> {
	if (pid == null) return false;
	const needle = safePid(pid);
	const cmd = isWin ? 'tasklist' : 'ps';
	const args = isWin
		? // NoHeader, FOrmat CSV, FIlter on pid:
			[
				['/NH', '/FO', 'CSV', '/FI', 'PID eq ' + needle],
				{
					windowsHide: true,
				},
			]
		: // linux has "quick" mode (-q) but mac doesn't. We add the ",1" to avoid ps
		// returning exit code 1, which generates an extraneous Error.
			[['-p', needle + ',1']];

	const p = Deno.run({
		cmd: [cmd, ...args[0] as string[]],
		...(args[1] || {}),
		stdin: 'piped',
		stdout: 'piped',
		stderr: 'piped'
	});

	const [ status, rawOutput/*, rawError*/] = await Promise.all([
		p.status(),
		p.output()
		// p.stderrOutput()
	]);
	const { code } = status;

	const output = new TextDecoder().decode(rawOutput);
	// @todo do we check rawError instead?
	// const rawError = await p.stderrOutput();

	try { p.stdin.close(); } catch(_) { /* */ }
	try { p.stdout.close(); } catch(_) { /* */ }
	try { p.stderr.close(); } catch(_) { /* */ }
	p.close();

	return code === 0 && new RegExp(
				isWin ? '"' + needle + '"' : '^\\s*' + needle + '\\b',
				// The posix regex pattern needs multiline support:
				'm',
			).exec(String(output).trim()) != null;
}

const winRe = /^".+?","(\d+)"/;
const posixRe = /^\s*(\d+)/;

/**
 * @export
 * @returns {Promise<number[]>} all the Process IDs in the process table.
 */
export async function pids(): Promise<number[]> {
	const p = Deno.run({
		cmd: [
			isWin ? 'tasklist' : 'ps',
			...(isWin ? ['/NH', '/FO', 'CSV'] : ['-e']),
		],
		stdin: 'piped',
		stdout: 'piped',
		stderr: 'piped'
	});
	const [ status, rawOutput, rawError] = await Promise.all([
		p.status(),
		p.output(),
		p.stderrOutput()
	]);
	const { code } = status;

	if (code !== 0 || ('' + rawError).trim().length > 0) {
		const errorString = new TextDecoder().decode(rawError);
		throw new Error(errorString);
	}

	try { p.stdin.close(); } catch(_) { /* */ }
	try { p.stdout.close(); } catch(_) { /* */ }
	try { p.stderr.close(); } catch(_) { /* */ }
	p.close();

	return new TextDecoder().decode(rawOutput)
		.trim()
		.split(/[\n\r]+/)
		.map((ea) => ea.match(isWin ? winRe : posixRe))
		.map((m) => map(m?.[0], parseInt))
		.filter((ea) => ea != null) as number[];
}

/**
 * Send a signal to the given process id.
 *
 * @export
 * @param {number} pid the process id. Required.
 * @param {boolean} [force=false] if true, and the current user has
 * permissions to send the signal, the pid will be forced to shut down.
 */
export function kill(pid: number | null | undefined, force = false): void {
	if (pid == null) return;

	if (pid === Deno.pid || pid === Deno.ppid) {
		throw new Error('cannot self-terminate');
	}

	if (isWin) {
		const args = ['/PID', safePid(pid), '/T'];
		if (force) {
			args.push('/F');
		}
		Deno.run({ cmd: ['taskkill', ...args] }).close();
	} else {
		try {
			Deno.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
		} catch (err) {
			if (!String(err).includes('ESRCH')) throw err;
		}
	}
}
