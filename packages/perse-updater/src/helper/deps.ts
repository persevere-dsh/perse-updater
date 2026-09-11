/**
 * Production dependency wiring for the helper process.
 *
 * Nothing here is Cordis- or typert-aware: the helper runs as a bare `node`
 * process so it can outlive the host it is replacing (`helper-protocol.md` §4).
 *
 * @module perse-updater/helper/deps
 */

import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runSelfCheck } from '../health/index.ts'
import { isolateBlockedTargets, restorePatchBackup } from '../isolate/index.ts'
import { entryFromBin, readCurrent } from '../installer/current.ts'
import { installVersioned } from '../installer/versioned-install.ts'
import { switchSymlink } from '../installer/symlink.ts'
import { isProcessAlive } from '../state/lock.ts'
import { portListening } from '../state/probes.ts'
import type { StateStore } from '../state/store.ts'
import type { JobRequest } from '../state/types.ts'
import { verifyInStaging } from '../staging/verify.ts'
import type { EnsureInstalledResult, HelperDeps, StartedInstance } from './types.ts'

/**
 * Build the production dependency set.
 *
 * @param store - store for the resolved home.
 * @returns the dependencies.
 */
export function defaultDeps(store: StateStore): HelperDeps {
  return {
    store,
    pid: store.pid,
    now: () => new Date(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    isAlive: isProcessAlive,
    portListening: (port, timeoutMs) => portListening(port, timeoutMs),
    ensureInstalled: ensureInstalled,
    verify: async request => verifyInStaging({
      version: request.version,
      candidateRoot: request.targetPrefix,
      dshHome: request.dshHome,
      profile: request.profile,
      installPrefix: request.targetPrefix,
    }),
    isolate: async request => isolateBlockedTargets({
      patchPath: request.patchPath,
      targets: request.isolateTargets,
      log: line => { process.stderr.write(`helper: ${line}\n`) },
    }),
    switchSymlink: async (symlinkPath, target) => switchSymlink({ symlinkPath, target }),
    health: async (request, bin) => runSelfCheck({
      port: request.port,
      bin,
      dshHome: request.dshHome,
      profile: request.profile,
      farmDir: join(request.dshHome, 'profiles', 'node_modules'),
      patchPath: request.patchPath,
      log: line => { process.stderr.write(`helper: ${line}\n`) },
    }),
    startInstance: async (request, bin, tag) => startInstance(request, bin, tag),
    stopHost: pid => {
      try {
        process.kill(pid, 'SIGTERM')
        process.stderr.write(`helper: sent SIGTERM to host pid ${pid}\n`)
      } catch (error) {
        process.stderr.write(`helper: could not SIGTERM host pid ${pid}: ${String(error)}\n`)
      }
    },
    restorePatch: async request => restorePatch(request, store),
    entryFromBin,
    log: line => { process.stderr.write(`helper: ${line}\n`) },
  }
}

/**
 * Treat an already-present, version-matching prefix as installed.
 *
 * The helper protocol says "install if not yet installed" (helper-protocol §5
 * step 2). The product assertions that guard a *fresh* install live in
 * `installer/versioned-install.ts` (C-2); for an existing prefix the decisive
 * gate is the shadow boot that follows (C-11), so a matching manifest plus a
 * launcher is the reuse condition here.
 */
async function ensureInstalled(request: JobRequest): Promise<EnsureInstalledResult> {
  const packageDir = join(request.targetPrefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
  const manifestPath = join(packageDir, 'package.json')
  if (existsSync(manifestPath) && existsSync(request.newBin) && manifestVersion(manifestPath) === request.version) {
    return {
      prefix: request.targetPrefix,
      bin: request.newBin,
      reused: true,
      detail: `reused existing ${request.version} at ${request.targetPrefix}`,
    }
  }
  const result = await installVersioned({
    version: request.version,
    runtimeRoot: request.runtimeRoot,
    cacheDir: join(request.dshHome, 'update-center', 'npm-cache'),
    log: line => { process.stderr.write(`helper: ${line}\n`) },
  })
  return {
    prefix: result.prefix,
    bin: result.bin,
    reused: result.reused,
    detail: result.reused
      ? `reused existing ${request.version} at ${result.prefix}`
      : `installed ${request.version} at ${result.prefix} (${result.durationMs} ms)`,
  }
}

/** Read a manifest's version, tolerating absence. */
function manifestVersion(path: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
}

/** Start one generation detached, redirecting its output to `~/.dsh/logs/`. */
function startInstance(request: JobRequest, bin: string, tag: string): Promise<StartedInstance> {
  const logDir = join(request.dshHome, 'logs')
  mkdirSync(logDir, { recursive: true })
  const logPath = join(logDir, `dsh-${request.profile}-${request.port}.log`)
  const fd = openSync(logPath, 'a')
  try {
    const child = spawn(process.execPath, [bin, '--profile', request.profile, '--port', String(request.port), '--no-open'], {
      env: { ...process.env, DSH_HOME: request.dshHome },
      detached: true,
      stdio: ['ignore', fd, fd],
    })
    child.unref()
    process.stderr.write(`helper: started ${tag} ${bin} pid=${String(child.pid)} log=${logPath}\n`)
    return Promise.resolve({ ...(child.pid === undefined ? {} : { pid: child.pid }), logPath })
  } finally {
    closeSync(fd)
  }
}

/** Restore the patch backup recorded in `current.json`, when one is recorded. */
async function restorePatch(request: JobRequest, store: StateStore): Promise<string | undefined> {
  const current = await readCurrent(store.paths.currentPath)
  const backup = current?.patchBackup
  if (backup === undefined || !existsSync(backup)) return undefined
  await restorePatchBackup(backup, request.patchPath)
  process.stderr.write(`helper: restored ${request.patchPath} from ${backup}\n`)
  return backup
}
