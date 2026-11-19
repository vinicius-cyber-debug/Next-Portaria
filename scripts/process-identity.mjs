import { readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, isAbsolute, basename } from 'node:path';

export function canonicalPath(value, platform = process.platform) {
  const path = resolve(value);
  return platform === 'win32' ? path.toLowerCase() : path;
}
/** Windows command-line quoting, including escaped quotes and trailing backslashes. */
export function windowsArguments(command) {
  const args = [];
  let i = 0;
  while (i < command.length) {
    while (/\s/.test(command[i] ?? '') && i < command.length) i++;
    if (i === command.length) break;
    let arg = '',
      quoted = false;
    while (i < command.length && (quoted || !/\s/.test(command[i]))) {
      let slashes = 0;
      while (command[i] === '\\') {
        slashes++;
        i++;
      }
      if (command[i] === '"') {
        arg += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2) arg += '"';
        else if (quoted && command[i + 1] === '"') {
          arg += '"';
          i++;
        } else quoted = !quoted;
        i++;
      } else {
        arg += '\\'.repeat(slashes);
        if (i < command.length && (quoted || !/\s/.test(command[i]))) arg += command[i++];
      }
    }
    args.push(arg);
  }
  return args;
}
const valueOptions = new Set([
  '--import',
  '--require',
  '-r',
  '--loader',
  '--experimental-loader',
  '--conditions',
  '-C',
  '--env-file',
  '--env-file-if-exists',
  '--icu-data-dir',
  '--openssl-config',
  '--inspect-port',
]);
const flagOptions = new Set([
  '--experimental-strip-types',
  '--no-warnings',
  '--enable-source-maps',
  '--experimental-vm-modules',
  '--no-experimental-strip-types',
  '--trace-warnings',
  '--inspect',
  '--inspect-brk',
]);
export function nodeEntrypoint(argv, cwd) {
  if (!Array.isArray(argv) || !cwd) return null;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') return argv[i + 1] ? resolve(cwd, argv[i + 1]) : null;
    if (
      ['-e', '--eval', '-p', '--print', '-'].includes(arg) ||
      arg.startsWith('--eval=') ||
      arg.startsWith('--print=')
    )
      return null;
    if (valueOptions.has(arg)) {
      i++;
      continue;
    }
    if (flagOptions.has(arg) || (arg.startsWith('--') && arg.includes('='))) continue;
    if (arg.startsWith('-')) return null;
    return isAbsolute(arg) ? arg : resolve(cwd, arg);
  }
  return null;
}
let clockTicks;
function linuxClockTicks() {
  if (!clockTicks) {
    const result = spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 2000 });
    clockTicks = result.status === 0 ? Number(result.stdout.trim()) : 0;
  }
  return clockTicks;
}
const linuxFields = (raw) =>
  raw
    .slice(raw.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
const linuxExited = (fields) => ['Z', 'X', 'x'].includes(fields[0]);

/** Separate dependencies let the /proc exit race be reproduced on Windows too. */
export function inspectLinuxProcess(
  pid,
  {
    readFile = readFileSync,
    readlink = readlinkSync,
    realpath = realpathSync,
    ticks = linuxClockTicks,
    probe = (value) => process.kill(value, 0),
  } = {},
) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'unknown' };
  const proc = '/proc/' + pid;
  try {
    const fields = linuxFields(readFile(proc + '/stat', 'utf8'));
    if (linuxExited(fields)) return { state: 'dead' };
    const startTicks = fields[19],
      boot = readFile('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
      frequency = ticks(),
      bootSeconds = Number(/^btime (\d+)$/m.exec(readFile('/proc/stat', 'utf8'))?.[1]);
    if (
      !Number.isFinite(frequency) ||
      frequency <= 0 ||
      !Number.isFinite(bootSeconds) ||
      !/^\d+$/.test(startTicks)
    )
      return { state: 'unknown' };
    return {
      state: 'live',
      pid,
      parentPid: Number(fields[1]),
      executable: realpath(proc + '/exe'),
      cwd: readlink(proc + '/cwd'),
      argv: readFile(proc + '/cmdline', 'utf8')
        .split('\0')
        .filter(Boolean),
      startedAt: Math.round(bootSeconds * 1000 + (Number(startTicks) * 1000) / frequency),
      startId: boot + ':' + startTicks,
    };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') {
      // SIGTERM can land between stat and exe/cwd. kill(pid, 0) still succeeds
      // for a zombie; re-read its state before calling that result unknown.
      try {
        if (linuxExited(linuxFields(readFile(proc + '/stat', 'utf8')))) return { state: 'dead' };
      } catch (retry) {
        if (retry.code !== 'ENOENT' && retry.code !== 'ESRCH') return { state: 'unknown' };
      }
      try {
        probe(pid);
      } catch (failure) {
        if (failure.code === 'ESRCH') return { state: 'dead' };
      }
    }
    return { state: 'unknown' };
  }
}

/** Confirmation only: an ambiguous inspection never causes another signal. */
export function waitForProcessExit(
  actual,
  {
    inspect = inspectProcess,
    timeoutMs = 12000,
    now = () => performance.now(),
    pause = (milliseconds) =>
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds),
  } = {},
) {
  const deadline = now() + timeoutMs;
  while (true) {
    const current = inspect(actual.pid);
    if (
      current.state === 'dead' ||
      (current.state === 'live' &&
        current.pid === actual.pid &&
        typeof current.startId === 'string' &&
        current.startId &&
        current.startId !== actual.startId)
    )
      return;
    if (now() >= deadline)
      throw Error(
        'Não foi possível confirmar o encerramento da aplicação. O registro foi preservado.',
      );
    pause(50);
  }
}
export function inspectProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'unknown' };
  if (process.platform === 'win32') {
    const command = `$ErrorActionPreference='Stop';try{$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}';if(!$p){'{"state":"dead"}';exit};if(!$p.CommandLine -or !$p.ExecutablePath -or !$p.CreationDate){'{"state":"unknown"}';exit};[pscustomobject]@{state='live';pid=$p.ProcessId;parentPid=$p.ParentProcessId;executable=$p.ExecutablePath;commandLine=$p.CommandLine;startedAt=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress}catch{'{"state":"unknown"}'}`;
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 },
    );
    try {
      if (result.error || result.status !== 0) return { state: 'unknown' };
      const actual = JSON.parse(result.stdout.trim());
      if (actual.state !== 'live') return actual;
      return {
        ...actual,
        argv: windowsArguments(actual.commandLine),
        startId: String(actual.startedAt),
      };
    } catch {
      return { state: 'unknown' };
    }
  }
  if (process.platform === 'linux') return inspectLinuxProcess(pid);
  return { state: 'unknown' };
}
export function nodeExecutable(path) {
  return ['node', 'node.exe', 'nodejs'].includes(basename(path ?? '').toLowerCase());
}
export function sameProcess(left, right) {
  return (
    left?.state === 'live' &&
    right?.state === 'live' &&
    left.pid === right.pid &&
    left.startId === right.startId &&
    canonicalPath(left.executable) === canonicalPath(right.executable) &&
    JSON.stringify(left.argv) === JSON.stringify(right.argv)
  );
}
/** Holds a Windows process handle while checking creation time and exact command. */
export function terminateProcess(
  actual,
  { inspect = inspectProcess, signal = (pid) => process.kill(pid, 'SIGTERM') } = {},
) {
  if (!sameProcess(actual, inspect(actual.pid)))
    throw Error('O processo mudou. Nenhum processo desconhecido foi encerrado.');
  if (process.platform !== 'win32') {
    signal(actual.pid);
    return;
  }
  const encoded = Buffer.from(actual.commandLine, 'utf8').toString('base64');
  const command = `$ErrorActionPreference='Stop';try{$target=[Diagnostics.Process]::GetProcessById(${actual.pid});$held=$target.Handle;$started=([DateTimeOffset]$target.StartTime).ToUnixTimeMilliseconds();$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${actual.pid}';$expected=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));if($started -ne ${actual.startedAt} -or !$p -or $p.CommandLine -cne $expected){exit 2};$target.Kill();if(!$target.WaitForExit(10000)){exit 3};exit 0}catch{exit 4}`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { windowsHide: true, stdio: 'ignore', timeout: 15000 },
  );
  if (result.error || result.status !== 0)
    throw Error('Não foi possível confirmar o encerramento da aplicação.');
}
