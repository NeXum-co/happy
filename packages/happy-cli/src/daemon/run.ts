import fs from 'fs/promises';
import os from 'os';
import * as tmp from 'tmp';
import axios from 'axios';

import { ApiClient } from '@/api/api';
import { TrackedSession, SessionEncryptionData } from './types';
import { MachineMetadata, DaemonState, Metadata } from '@/api/types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';
import { writeDaemonState, DaemonLocallyPersistedState, readDaemonState, acquireDaemonLock, releaseDaemonLock, readPersistedSessions, persistSession, readCredentials } from '@/persistence';
import { startAuthProxy, type AuthProxy } from '@/accounts/authProxy';
import { applyAccountBinding } from '@/accounts/accountBinding';
import { applyAccountSwitch, type SwitchResult } from '@/accounts/accountSwitch';
import { createUsageStore, type AccountUsage } from '@/accounts/usageStore';
import { vaultMasterKey, listAccounts, addAccount, removeAccount, setDefaultAccount, getBurnPolicy, setBurnPolicy, type AccountInfo } from '@/accounts/accountVault';
import { planBurnRemap, type BurnPolicyConfig } from '@/accounts/burnPolicy';
import type { PersistedSession } from '@/persistence';

import { cleanupDaemonState, isDaemonRunningCurrentlyInstalledHappyVersion, stopDaemon } from './controlClient';
import { runReaperOnce, isPidAlive } from './reaper';
import { loadProfiles, sanitizeWindowName } from './profiles';
import { startDaemonControlServer } from './controlServer';
import { JobStore } from './jobs/jobStore';
import { Semaphore } from './jobs/semaphore';
import { JobScheduler, buildJobFromSubmit } from './jobs/scheduler';
import { CronStore } from './jobs/cronStore';
import { CronFeeder, buildCronFromSubmit, type SubmitCronParams } from './jobs/cronFeeder';
import { validateCronExpr } from './jobs/cronSchedule';
import type { CronScheduleView } from './jobs/cronTypes';
import { EventStore } from './jobs/eventStore';
import { matchSubscriptions, buildEventJob, buildEventSubscriptionFromSubmit, type SubmitEventSubscriptionParams } from './jobs/eventTrigger';
import type { EventSubscriptionView } from './jobs/eventTypes';
import type { SubmitJobParams } from '@/api/apiMachine';
import type { JobStatus } from './jobs/jobTypes';
import { toJobRecordView } from './jobs/jobView';
import { randomUUID } from 'crypto';
import { statSync } from 'fs';
import { join } from 'path';
import { projectPath } from '@/projectPath';
import { getTmuxUtilities, isTmuxAvailable, parseTmuxSessionIdentifier, formatTmuxSessionIdentifier } from '@/utils/tmux';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import { detectCLIAvailability } from '@/utils/detectCLI';
import { buildResumeLaunch } from '@/resume/handleResumeCommand';
import { detectResumeSupport } from '@/resume/localHappyAgentAuth';
import { encodeBase64, decodeBase64, decrypt } from '@/api/encryption';

/** Shell-escape a string for safe interpolation into tmux commands. */
function shellescape(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'";
}

// Prepare initial metadata
// Suffix host with `-dev` for the HAPPY_VARIANT=dev variant so the dev daemon
// is visually distinct from the stable one in the machine list (they otherwise
// share the same hostname and look identical).
const hostSuffix = process.env.HAPPY_VARIANT === 'dev' ? '-dev' : '';
export const initialMachineMetadata: MachineMetadata = {
  host: os.hostname() + hostSuffix,
  platform: os.platform(),
  happyCliVersion: packageJson.version,
  homeDir: os.homedir(),
  happyHomeDir: configuration.happyHomeDir,
  happyLibDir: projectPath(),
  cliAvailability: detectCLIAvailability(),
  resumeSupport: { ...detectResumeSupport(), rpcAvailable: true },
};

export async function startDaemon(): Promise<void> {
  // We don't have cleanup function at the time of server construction
  // Control flow is:
  // 1. Create promise that will resolve when shutdown is requested
  // 2. Setup signal handlers to resolve this promise with the source of the shutdown
  // 3. Once our setup is complete - if all goes well - we await this promise
  // 4. When it resolves we can cleanup and exit
  //
  // In case the setup malfunctions - our signal handlers will not properly
  // shut down. We will force exit the process with code 1.
  let requestShutdown: (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string) => void;
  let resolvesWhenShutdownRequested = new Promise<({ source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string })>((resolve) => {
    requestShutdown = (source, errorMessage) => {
      logger.debug(`[DAEMON RUN] Requesting shutdown (source: ${source}, errorMessage: ${errorMessage})`);

      // Fallback - in case startup malfunctions - we will force exit the process with code 1
      setTimeout(async () => {
        logger.debug('[DAEMON RUN] Startup malfunctioned, forcing exit with code 1');

        // Give time for logs to be flushed
        await new Promise(resolve => setTimeout(resolve, 100))

        process.exit(1);
      }, 1_000);

      // Start graceful shutdown
      resolve({ source, errorMessage });
    };
  });

  // Setup signal handlers
  process.on('SIGINT', () => {
    logger.debug('[DAEMON RUN] Received SIGINT');
    requestShutdown('os-signal');
  });

  process.on('SIGTERM', () => {
    logger.debug('[DAEMON RUN] Received SIGTERM');
    requestShutdown('os-signal');
  });

  process.on('uncaughtException', (error) => {
    logger.debug('[DAEMON RUN] FATAL: Uncaught exception', error);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.debug('[DAEMON RUN] FATAL: Unhandled promise rejection', reason);
    logger.debug(`[DAEMON RUN] Rejected promise:`, promise);
    const error = reason instanceof Error ? reason : new Error(`Unhandled promise rejection: ${reason}`);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('exit', (code) => {
    logger.debug(`[DAEMON RUN] Process exiting with code: ${code}`);
  });

  process.on('beforeExit', (code) => {
    logger.debug(`[DAEMON RUN] Process about to exit with code: ${code}`);
  });

  logger.debug('[DAEMON RUN] Starting daemon process...');
  logger.debugLargeJson('[DAEMON RUN] Environment', getEnvironmentInfo());

  // Check if already running
  // Check if running daemon version matches current CLI version
  const runningDaemonVersionMatches = await isDaemonRunningCurrentlyInstalledHappyVersion();
  if (!runningDaemonVersionMatches) {
    // TODO: This hand-rolled self-restart path is awkward to reason about and awkward to test.
    // We should probably migrate this daemon to native system service management
    // (launchd/systemd, similar to OpenClaw's model), so startup/start-at-login and upgrades
    // are owned by the OS instead of by the daemon trying to replace itself in-process.
    logger.debug('[DAEMON RUN] Daemon version mismatch detected, restarting daemon with current CLI version');
    await stopDaemon();
  } else {
    logger.debug('[DAEMON RUN] Daemon version matches, keeping existing daemon');
    console.log('Daemon already running with matching version');
    process.exit(0);
  }

  // Acquire exclusive lock (proves daemon is running)
  const daemonLockHandle = await acquireDaemonLock(5, 200);
  if (!daemonLockHandle) {
    logger.debug('[DAEMON RUN] Daemon lock file already held, another daemon is running');
    process.exit(0);
  }

  // At this point we should be safe to startup the daemon:
  // 1. Not have a stale daemon state
  // 2. Should not have another daemon process running

  try {
    // Start caffeinate
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
      logger.debug('[DAEMON RUN] Sleep prevention enabled');
    }

    // Ensure auth and machine registration BEFORE anything else
    const { credentials, machineId } = await authAndSetupMachineIfNeeded();
    logger.debug('[DAEMON RUN] Auth and machine setup complete');

    // Setup state - key by PID
    const pidToTrackedSession = new Map<number, TrackedSession>();

    // Retain session data after process exits so resume can still find it.
    // Pre-populate from disk so sessions survive daemon restarts.
    const sessionIdToFinishedSession = new Map<string, TrackedSession>();
    const persisted = readPersistedSessions();
    for (const [id, s] of Object.entries(persisted)) {
      sessionIdToFinishedSession.set(id, {
        startedBy: 'persisted',
        happySessionId: id,
        happySessionMetadataFromLocalWebhook: s.metadata,
        encryption: {
          encryptionKey: decodeBase64(s.encryptionKey),
          encryptionVariant: s.encryptionVariant,
          seq: s.seq,
          metadataVersion: s.metadataVersion,
          agentStateVersion: s.agentStateVersion,
        },
        pid: 0,
      });
    }
    if (Object.keys(persisted).length > 0) {
      logger.debug(`[DAEMON RUN] Loaded ${Object.keys(persisted).length} persisted sessions from disk`);
    }

    // Session spawning awaiter system
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    // Helper functions
    const getCurrentChildren = () => Array.from(pidToTrackedSession.values());

    // Handle webhook from happy session reporting itself
    const onHappySessionWebhook = (sessionId: string, sessionMetadata: Metadata, encryption?: SessionEncryptionData) => {
      logger.debugLargeJson(`[DAEMON RUN] Session reported`, sessionMetadata);

      const pid = sessionMetadata.hostPid;
      if (!pid) {
        logger.debug(`[DAEMON RUN] Session webhook missing hostPid for sessionId: ${sessionId}`);
        return;
      }

      logger.debug(`[DAEMON RUN] Session webhook: ${sessionId}, PID: ${pid}, started by: ${sessionMetadata.startedBy || 'unknown'}, hasEncryption: ${!!encryption}`);
      logger.debug(`[DAEMON RUN] Current tracked sessions before webhook: ${Array.from(pidToTrackedSession.keys()).join(', ')}`);

      // Persist encryption data to disk so it survives daemon restarts
      if (encryption) {
        persistSession(sessionId, {
          encryptionKey: encodeBase64(encryption.encryptionKey),
          encryptionVariant: encryption.encryptionVariant,
          seq: encryption.seq,
          metadataVersion: encryption.metadataVersion,
          agentStateVersion: encryption.agentStateVersion,
          metadata: sessionMetadata,
          savedAt: Date.now(),
        });
      }

      // Check if we already have this PID (daemon-spawned)
      const existingSession = pidToTrackedSession.get(pid);

      if (existingSession && existingSession.startedBy === 'daemon') {
        // Update daemon-spawned session with reported data
        existingSession.happySessionId = sessionId;
        existingSession.happySessionMetadataFromLocalWebhook = sessionMetadata;
        existingSession.encryption = encryption;
        logger.debug(`[DAEMON RUN] Updated daemon-spawned session ${sessionId} with metadata`);

        // Resolve any awaiter for this PID
        const awaiter = pidToAwaiter.get(pid);
        if (awaiter) {
          pidToAwaiter.delete(pid);
          awaiter(existingSession);
          logger.debug(`[DAEMON RUN] Resolved session awaiter for PID ${pid}`);
        }
      } else if (!existingSession) {
        // New session started externally
        const trackedSession: TrackedSession = {
          startedBy: 'happy directly - likely by user from terminal',
          happySessionId: sessionId,
          happySessionMetadataFromLocalWebhook: sessionMetadata,
          encryption,
          pid
        };
        pidToTrackedSession.set(pid, trackedSession);
        logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
      }
    };

    // E10: localhost-only auth-proxy die per cloud-sessie het echte account-token
    // injecteert. Gestart vóór spawnSession zodat de closure 'm capteert; gestopt
    // in cleanupAndShutdown. S4: de proxy meldt per response het account + de
    // upstream-headers aan de usageStore (proxy blijft dom — D-E10-14).
    const usageStore = createUsageStore();
    const authProxy: AuthProxy = await startAuthProxy({
      onResponse: (account, headers) => usageStore.record(account, headers),
    });
    logger.debug(`[DAEMON RUN] authProxy (E10) luistert op http://127.0.0.1:${authProxy.port}`);

    // Spawn a new session (sessionId reserved for future --resume functionality)
    const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
      logger.debugLargeJson('[DAEMON RUN] Spawning session', options);

      const { sessionId, machineId, approvedNewDirectoryCreation = true } = options;
      let directoryCreated = false;

      // Profile resolution (preset spawn): a named profile from
      // <happy-home>/profiles.json supplies directory, extra claude args and
      // the target tmux session. No git logic here by design (D-E02-8).
      let directory = options.directory;
      let profileClaudeArgs: string[] = [];
      let profileTmuxSession: string | undefined;
      if (options.profile) {
        const profile = loadProfiles().find(p => p.name === options.profile);
        if (!profile) {
          return {
            type: 'error',
            errorMessage: `Unknown profile '${options.profile}'. Profiles are defined in ${join(configuration.happyHomeDir, 'profiles.json')}.`
          };
        }
        directory = profile.directory;
        profileClaudeArgs = profile.claudeArgs;
        profileTmuxSession = profile.tmuxSession;
        logger.debug(`[DAEMON RUN] Resolved profile '${profile.name}': directory=${directory}, tmuxSession=${profileTmuxSession ?? '(none)'}, claudeArgs=${JSON.stringify(profileClaudeArgs)}`);
      }
      if (!directory) {
        return {
          type: 'error',
          errorMessage: 'Directory is required when no profile is specified'
        };
      }

      try {
        await fs.access(directory);
        logger.debug(`[DAEMON RUN] Directory exists: ${directory}`);
      } catch (error) {
        logger.debug(`[DAEMON RUN] Directory doesn't exist, creating: ${directory}`);

        // Check if directory creation is approved
        if (!approvedNewDirectoryCreation) {
          logger.debug(`[DAEMON RUN] Directory creation not approved for: ${directory}`);
          return {
            type: 'requestToApproveDirectoryCreation',
            directory
          };
        }

        try {
          await fs.mkdir(directory, { recursive: true });
          logger.debug(`[DAEMON RUN] Successfully created directory: ${directory}`);
          directoryCreated = true;
        } catch (mkdirError: any) {
          let errorMessage = `Unable to create directory at '${directory}'. `;

          // Provide more helpful error messages based on the error code
          if (mkdirError.code === 'EACCES') {
            errorMessage += `Permission denied. You don't have write access to create a folder at this location. Try using a different path or check your permissions.`;
          } else if (mkdirError.code === 'ENOTDIR') {
            errorMessage += `A file already exists at this path or in the parent path. Cannot create a directory here. Please choose a different location.`;
          } else if (mkdirError.code === 'ENOSPC') {
            errorMessage += `No space left on device. Your disk is full. Please free up some space and try again.`;
          } else if (mkdirError.code === 'EROFS') {
            errorMessage += `The file system is read-only. Cannot create directories here. Please choose a writable location.`;
          } else {
            errorMessage += `System error: ${mkdirError.message || mkdirError}. Please verify the path is valid and you have the necessary permissions.`;
          }

          logger.debug(`[DAEMON RUN] Directory creation failed: ${errorMessage}`);
          return {
            type: 'error',
            errorMessage
          };
        }
      }

      try {

        // Build environment variables for session spawning
        // Authentication tokens are resolved here

        // Resolve authentication token if provided
        const authEnv: Record<string, string> = {};
        if (options.token) {
          if (options.agent === 'codex') {

            // Create a temporary directory for Codex
            const codexHomeDir = tmp.dirSync();

            // Write the token to the temporary directory
            await fs.writeFile(join(codexHomeDir.name, 'auth.json'), options.token);

            // Set the environment variable for Codex
            authEnv.CODEX_HOME = codexHomeDir.name;
          } else { // Assuming claude
            authEnv.CLAUDE_CODE_OAUTH_TOKEN = options.token;
          }
        }

        let extraEnv: Record<string, string> = {
          ...authEnv,
          ...(options.environmentVariables ?? {}),
        };
        if (options.parentSessionId) {
          extraEnv.HAPPY_FORKED_FROM_SESSION_ID = options.parentSessionId;
        }
        if (options.forkedFromMessageId) {
          extraEnv.HAPPY_FORKED_FROM_MESSAGE_ID = options.forkedFromMessageId;
        }
        // For fork: spawned Happy CLI needs to know which Claude JSONL to
        // backfill into the fresh Happy session row. Without this, the
        // SDK reads the JSONL silently as context but never re-emits the
        // historical messages, so the app shows an empty chat.
        if (options.resumeClaudeSessionId) {
          extraEnv.HAPPY_FORK_CLAUDE_SESSION_ID = options.resumeClaudeSessionId;
        }

        // E10: bind deze cloud-spawn aan een account (engaged-only, fail-closed).
        // Niet-claude/local-preset spawns en een lege vault passeren ongemoeid.
        // S6: zonder expliciete keuze stuurt de burn-policy (config + live usage) de
        // account-keuze; álle accounts vol → warn + default-fallback (D-E10-19).
        const accountCreds = await readCredentials();
        const binding = accountCreds
          ? await applyAccountBinding(extraEnv, { agent: options.agent, account: options.account },
              { vaultFile: configuration.accountsVaultFile, masterKey: await vaultMasterKey(accountCreds), proxy: authProxy,
                burnPolicy: await getBurnPolicy(configuration.accountsVaultFile, 'claude'), usage: usageStore.snapshot() })
          : { ok: true as const, stripApiKey: false };
        if (!binding.ok) {
          return { type: 'error', errorMessage: binding.error };
        }
        if (binding.ok && binding.warning) {
          logger.warn(`[DAEMON RUN] ${binding.warning}`);
        }
        const stripApiKey = binding.stripApiKey;
        // E10/S3: routing-key + account vasthouden zodat de TrackedSession ze draagt
        // (live-switch via accountSwitch → authProxy.remap). undefined bij passthrough.
        const accountBinding = binding.binding;

        logger.debug(`[DAEMON RUN] Environment variable keys (before expansion) (${Object.keys(extraEnv).length}): ${Object.keys(extraEnv).join(', ')}`);

        // Expand ${VAR} references from daemon's process.env
        // This ensures variable substitution works in both tmux and non-tmux modes
        // Example: ANTHROPIC_AUTH_TOKEN="${Z_AI_AUTH_TOKEN}" → ANTHROPIC_AUTH_TOKEN="sk-real-key"
        extraEnv = expandEnvironmentVariables(extraEnv, process.env);
        logger.debug(`[DAEMON RUN] After variable expansion: ${Object.keys(extraEnv).join(', ')}`);

        // Fail fast if any passed-through environment variable still contains an
        // unresolved ${VAR} reference after expansion.
        const unresolvedEnvEntries = Object.entries(extraEnv).flatMap(([key, value]) => {
          if (typeof value !== 'string' || !value.includes('${')) {
            return [];
          }

          const unresolvedMatch = value.match(/\$\{([^}]+)\}/);
          if (!unresolvedMatch) {
            return [];
          }

          const expression = unresolvedMatch[1];
          const defaultSeparatorIndex = expression.indexOf(':-');
          const missingVar = defaultSeparatorIndex === -1
            ? expression
            : expression.slice(0, defaultSeparatorIndex);

          return [`${key} references \${${missingVar}} which is not defined`];
        });

        if (unresolvedEnvEntries.length > 0) {
          const errorMessage = `Session environment is invalid - environment variables not found in daemon: ${unresolvedEnvEntries.join('; ')}. ` +
            `Ensure these variables are set in the daemon's environment before starting sessions.`;
          logger.warn(`[DAEMON RUN] ${errorMessage}`);
          return {
            type: 'error',
            errorMessage
          };
        }

        // Autonomous-job seed prompt: added AFTER expansion + unresolved-${VAR}
        // validation, because the prompt is free text that may legitimately
        // contain `$` or `${...}` and must travel through verbatim, not be
        // expanded or rejected. Both spawn branches below read `extraEnv`
        // (tmux: Object.assign(tmuxEnv, extraEnv); non-tmux: {...process.env, ...extraEnv}).
        if (options.initialPrompt) {
          extraEnv.HAPPY_INITIAL_PROMPT = options.initialPrompt;
        }

        // Profile-provided tmux session. Explicitly passed environment
        // variables still win so callers can override the profile.
        if (profileTmuxSession !== undefined && extraEnv.TMUX_SESSION_NAME === undefined) {
          extraEnv.TMUX_SESSION_NAME = profileTmuxSession;
        }

        // Check if tmux is available and should be used
        const tmuxAvailable = await isTmuxAvailable();
        let useTmux = tmuxAvailable;
        // When tmux was requested but the spawn failed, the fallback result
        // message must say so (SF-003) — the user expects a tmux window.
        let tmuxSpawnError: string | undefined;

        // Get tmux session name from environment variables (now set by profile system)
        // Empty string means "use current/most recent session" (tmux default behavior)
        let tmuxSessionName: string | undefined = extraEnv.TMUX_SESSION_NAME;

        // If tmux is not available or session name is explicitly undefined, fall back to regular spawning
        // Note: Empty string is valid (means use current/most recent tmux session)
        if (!tmuxAvailable || tmuxSessionName === undefined) {
          useTmux = false;
          if (tmuxSessionName !== undefined) {
            logger.debug(`[DAEMON RUN] tmux session name specified but tmux not available, falling back to regular spawning`);
          }
        }

        if (useTmux && tmuxSessionName !== undefined) {
          // Try to spawn in tmux session
          const sessionDesc = tmuxSessionName || 'current/most recent session';
          logger.debug(`[DAEMON RUN] Attempting to spawn session in tmux: ${sessionDesc}`);

          const tmux = getTmuxUtilities(tmuxSessionName);

          // Construct command for the CLI
          const cliPath = join(projectPath(), 'dist', 'index.mjs');
          // Determine agent command - support claude, codex, and gemini
          const agent = options.agent === 'gemini' ? 'gemini' : (options.agent === 'codex' ? 'codex' : (options.agent === 'openclaw' ? 'openclaw' : 'claude'));
          // Restrict resume to Claude — Codex/Gemini don't honour the
          // happy-pass-through `--resume <id>` argument the same way.
          const resumeFragment = options.resumeClaudeSessionId && agent === 'claude'
            ? ` --resume ${shellescape(options.resumeClaudeSessionId)}`
            : '';
          // Extra claude args from the profile are passed through happy's
          // pass-through arg handling (claude only, like --resume above).
          const profileArgsFragment = agent === 'claude' && profileClaudeArgs.length > 0
            ? ' ' + profileClaudeArgs.map(shellescape).join(' ')
            : '';
          const fullCommand = `node --no-warnings --no-deprecation ${cliPath} ${agent} --happy-starting-mode remote --started-by daemon${resumeFragment}${profileArgsFragment}`;

          // Spawn in tmux with environment variables
          // IMPORTANT: Pass complete environment (process.env + extraEnv) because:
          // 1. tmux sessions need daemon's expanded auth variables (e.g., ANTHROPIC_AUTH_TOKEN)
          // 2. Regular spawn uses env: { ...process.env, ...extraEnv }
          // 3. tmux needs explicit environment via -e flags to ensure all variables are available
          const requestedWindowName = options.sessionName ? sanitizeWindowName(options.sessionName) : '';
          const windowName = requestedWindowName || `happy-${Date.now()}-${agent}`;
          const tmuxEnv: Record<string, string> = {};

          // Add all daemon environment variables (filtering out undefined)
          for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined) {
              tmuxEnv[key] = value;
            }
          }

          // Add extra environment variables (these should already be filtered)
          Object.assign(tmuxEnv, extraEnv);

          // E10: strip ANTHROPIC_API_KEY zodra account-binding actief is, anders
          // overruled een geërfde key stil de routing-key (proxy wordt omzeild).
          if (stripApiKey) delete tmuxEnv.ANTHROPIC_API_KEY;

          const tmuxResult = await tmux.spawnInTmux([fullCommand], {
            sessionName: tmuxSessionName,
            windowName: windowName,
            cwd: directory
          }, tmuxEnv);  // Pass complete environment for tmux session

          if (tmuxResult.success) {
            logger.debug(`[DAEMON RUN] Successfully spawned in tmux session: ${tmuxResult.sessionId}, PID: ${tmuxResult.pid}`);

            // Validate we got a PID from tmux
            if (!tmuxResult.pid) {
              throw new Error('Tmux window created but no PID returned');
            }

            // Create a tracked session for tmux windows - now we have the real PID!
            const trackedSession: TrackedSession = {
              startedBy: 'daemon',
              pid: tmuxResult.pid, // Real PID from tmux -P flag
              tmuxSessionId: tmuxResult.sessionId,
              directoryCreated,
              routingKey: accountBinding?.routingKey,
              account: accountBinding?.account,
              message: directoryCreated
                ? `The path '${directory}' did not exist. We created a new folder and spawned a new session in tmux session '${tmuxSessionName}'. Use 'tmux attach -t ${tmuxSessionName}' to view the session.`
                : `Spawned new session in tmux session '${tmuxSessionName}'. Use 'tmux attach -t ${tmuxSessionName}' to view the session.`
            };

            // Add to tracking map so webhook can find it later
            pidToTrackedSession.set(tmuxResult.pid, trackedSession);

            // Wait for webhook to populate session with happySessionId (exact same as regular flow)
            logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${tmuxResult.pid} (tmux)`);

            return new Promise((resolve) => {
              // Set timeout for webhook (same as regular flow)
              const timeout = setTimeout(() => {
                pidToAwaiter.delete(tmuxResult.pid!);
                logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${tmuxResult.pid} (tmux)`);
                resolve({
                  type: 'error',
                  errorMessage: `Session webhook timeout for PID ${tmuxResult.pid} (tmux)`
                });
              }, 15_000); // Same timeout as regular sessions

              // Register awaiter for tmux session (exact same as regular flow)
              pidToAwaiter.set(tmuxResult.pid!, (completedSession) => {
                clearTimeout(timeout);
                logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook (tmux)`);
                resolve({
                  type: 'success',
                  sessionId: completedSession.happySessionId!
                });
              });
            });
          } else {
            logger.warn(`[DAEMON RUN] Failed to spawn in tmux: ${tmuxResult.error}, falling back to regular spawning`);
            tmuxSpawnError = tmuxResult.error ?? 'unknown error';
            useTmux = false;
          }
        }

        // Regular process spawning (fallback or if tmux not available)
        if (!useTmux) {
          logger.debug(`[DAEMON RUN] Using regular process spawning`);

          // Construct arguments for the CLI - support claude, codex, and gemini
          let agentCommand: string;
          switch (options.agent) {
            case 'claude':
            case undefined:
              agentCommand = 'claude';
              break;
            case 'codex':
              agentCommand = 'codex';
              break;
            case 'gemini':
              agentCommand = 'gemini';
              break;
            case 'openclaw':
              agentCommand = 'openclaw';
              break;
            default:
              return {
                type: 'error',
                errorMessage: `Unsupported agent type: '${options.agent}'. Please update your CLI to the latest version.`
              };
          }
          const args = [
            agentCommand,
            '--happy-starting-mode', 'remote',
            '--started-by', 'daemon'
          ];

          // resumeClaudeSessionId attaches the new Happy session to a pre-existing
          // Claude conversation file (used by the fork / duplicate flow). We pass
          // it through `--resume <id>` as Happy's existing pass-through to claude.
          if (options.resumeClaudeSessionId && agentCommand === 'claude') {
            args.push('--resume', options.resumeClaudeSessionId);
          }

          // Extra claude args from the profile (claude only, pass-through).
          if (agentCommand === 'claude' && profileClaudeArgs.length > 0) {
            args.push(...profileClaudeArgs);
          }

          // TODO: In future, sessionId could be used with --resume to continue existing sessions
          // For now, we ignore it - each spawn creates a new session
          const messageParts = [
            directoryCreated ? `The path '${directory}' did not exist. We created a new folder and spawned a new session there.` : undefined,
            // SF-003: tmux was requested but failed — without this note the
            // user silently gets a detached session instead of a tmux window.
            tmuxSpawnError !== undefined ? `tmux spawn failed (${tmuxSpawnError}); the session is running detached instead of in tmux.` : undefined,
          ].filter((part): part is string => part !== undefined);
          return spawnTrackedHappyProcess({
            args,
            cwd: directory,
            routingKey: accountBinding?.routingKey,
            account: accountBinding?.account,
            env: (() => {
              const childEnv: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
              // E10: zie tmux-tak — strip de geërfde API-key bij actieve binding.
              if (stripApiKey) delete childEnv.ANTHROPIC_API_KEY;
              return childEnv;
            })(),
            directoryCreated,
            message: messageParts.length > 0 ? messageParts.join(' ') : undefined,
          });
        }

        // This should never be reached, but TypeScript requires a return statement
        return {
          type: 'error',
          errorMessage: 'Unexpected error in session spawning'
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.debug('[DAEMON RUN] Failed to spawn session:', error);
        return {
          type: 'error',
          errorMessage: `Failed to spawn session: ${errorMessage}`
        };
      }
    };

    const spawnTrackedHappyProcess = ({
      args,
      cwd,
      env,
      directoryCreated = false,
      message,
      routingKey,
      account,
    }: {
      args: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
      directoryCreated?: boolean;
      message?: string;
      routingKey?: string;
      account?: string;
    }): Promise<SpawnSessionResult> => {
      const happyProcess = spawnHappyCLI(args, {
        cwd,
        detached: true,
        stdio: 'ignore',
        env,
      });

      if (!happyProcess.pid) {
        logger.debug('[DAEMON RUN] Failed to spawn process - no PID returned');
        return Promise.resolve({
          type: 'error',
          errorMessage: 'Failed to spawn Happy process - no PID returned'
        });
      }

      logger.debug(`[DAEMON RUN] Spawned process with PID ${happyProcess.pid}`);

      const trackedSession: TrackedSession = {
        startedBy: 'daemon',
        pid: happyProcess.pid,
        childProcess: happyProcess,
        directoryCreated,
        message,
        routingKey,
        account,
      };

      pidToTrackedSession.set(happyProcess.pid, trackedSession);

      happyProcess.on('exit', (code, signal) => {
        logger.debug(`[DAEMON RUN] Child PID ${happyProcess.pid} exited with code ${code}, signal ${signal}`);
        if (happyProcess.pid) {
          // Bind the process exit to the autonomous job lifecycle (P7). Read the
          // sessionId before onChildExited untracks the pid. findBySessionId is a
          // no-op for non-job sessions, so this is safe for normal sessions.
          const exited = pidToTrackedSession.get(happyProcess.pid);
          if (exited?.happySessionId) {
            jobScheduler.onSessionExit(exited.happySessionId, code === 0 ? 'success' : 'crashed');
          }
          onChildExited(happyProcess.pid);
        }
      });

      happyProcess.on('error', (error) => {
        logger.debug(`[DAEMON RUN] Child process error:`, error);
        if (happyProcess.pid) {
          onChildExited(happyProcess.pid);
        }
      });

      logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${happyProcess.pid}`);

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          pidToAwaiter.delete(happyProcess.pid!);
          logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${happyProcess.pid}`);
          resolve({
            type: 'error',
            errorMessage: `Session webhook timeout for PID ${happyProcess.pid}`
          });
        }, 15_000);

        pidToAwaiter.set(happyProcess.pid!, (completedSession) => {
          clearTimeout(timeout);
          logger.debug(`[DAEMON RUN] Session ${completedSession.happySessionId} fully spawned with webhook`);
          resolve({
            type: 'success',
            sessionId: completedSession.happySessionId!,
            pid: happyProcess.pid!
          });
        });
      });
    };

    const findTrackedSessionById = (happySessionId: string): TrackedSession | undefined => {
      for (const session of pidToTrackedSession.values()) {
        if (session.happySessionId === happySessionId) return session;
      }
      return sessionIdToFinishedSession.get(happySessionId);
    };

    const fetchServerSessionMetadata = async (sessionId: string, encryptionKey: Uint8Array, encryptionVariant: 'legacy' | 'dataKey'): Promise<Metadata | null> => {
      try {
        const response = await axios.get(`${configuration.serverUrl}/v1/sessions`, {
          headers: { Authorization: `Bearer ${credentials.token}` },
          timeout: 10_000,
        });
        const sessions = (response.data as { sessions: { id: string; metadata: string }[] }).sessions;
        const matched = sessions.find(s => s.id === sessionId);
        if (!matched) return null;
        const decrypted = decrypt(encryptionKey, encryptionVariant, decodeBase64(matched.metadata));
        return decrypted as Metadata | null;
      } catch (error) {
        logger.debug(`[DAEMON RUN] Failed to fetch session metadata from server: ${error instanceof Error ? error.message : error}`);
        return null;
      }
    };

    const resumeSession = async (happySessionId: string, options?: { model?: string; permissionMode?: string }): Promise<SpawnSessionResult> => {
      try {
        const tracked = findTrackedSessionById(happySessionId);
        if (!tracked) {
          return { type: 'error', errorMessage: `Session ${happySessionId} is not tracked by this daemon. It may have been started before the daemon or on another machine.` };
        }
        if (!tracked.happySessionMetadataFromLocalWebhook) {
          return { type: 'error', errorMessage: `Session ${happySessionId} has no metadata. Cannot resume.` };
        }
        if (!tracked.encryption) {
          return { type: 'error', errorMessage: `Session ${happySessionId} has no stored encryption data. It was likely started before this feature was available. Restart the daemon and start a new session to enable resume.` };
        }

        // Webhook metadata may be stale (missing claudeSessionId/codexThreadId set after startup).
        // Fetch fresh metadata from server if needed.
        let metadata = tracked.happySessionMetadataFromLocalWebhook;
        const needsFetch = (!metadata.claudeSessionId && (!metadata.flavor || metadata.flavor === 'claude'))
          || (!metadata.codexThreadId && metadata.flavor === 'codex');
        if (needsFetch) {
          logger.debug(`[DAEMON RUN] Session ${happySessionId} missing agent session ID in webhook metadata, fetching from server`);
          const serverMetadata = await fetchServerSessionMetadata(happySessionId, tracked.encryption.encryptionKey, tracked.encryption.encryptionVariant);
          if (serverMetadata) {
            metadata = serverMetadata;
            tracked.happySessionMetadataFromLocalWebhook = serverMetadata;
          }
        }

        const launch = buildResumeLaunch(
          { id: happySessionId, active: true, metadata },
          { startedBy: 'daemon', claudeStartingMode: 'remote' },
        );

        if (options?.model) {
          launch.args.push('--model', options.model);
        }
        if (options?.permissionMode) {
          launch.args.push('--permission-mode', options.permissionMode);
        }

        await fs.access(launch.cwd);

        return spawnTrackedHappyProcess({
          args: launch.args,
          cwd: launch.cwd,
          env: {
            ...process.env,
            HAPPY_RECONNECT_SESSION_ID: happySessionId,
            HAPPY_RECONNECT_ENCRYPTION_KEY: encodeBase64(tracked.encryption.encryptionKey),
            HAPPY_RECONNECT_ENCRYPTION_VARIANT: tracked.encryption.encryptionVariant,
            HAPPY_RECONNECT_SEQ: String(tracked.encryption.seq),
            HAPPY_RECONNECT_METADATA_VERSION: String(tracked.encryption.metadataVersion),
            HAPPY_RECONNECT_AGENT_STATE_VERSION: String(tracked.encryption.agentStateVersion),
          },
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : (error && typeof error === 'object' ? JSON.stringify(error) : String(error));
        logger.debug(`[DAEMON RUN] Failed to resume session: ${errorMessage}`, error instanceof Error ? error.stack : undefined);
        return {
          type: 'error',
          errorMessage: `Failed to resume session: ${errorMessage}`,
        };
      }
    };

    // Stop a session by sessionId or PID fallback
    const stopSession = (sessionId: string): boolean => {
      logger.debug(`[DAEMON RUN] Attempting to stop session ${sessionId}`);

      // Try to find by sessionId first
      for (const [pid, session] of pidToTrackedSession.entries()) {
        if (session.happySessionId === sessionId ||
          (sessionId.startsWith('PID-') && pid === parseInt(sessionId.replace('PID-', '')))) {

          if (session.startedBy === 'daemon' && session.childProcess) {
            try {
              session.childProcess.kill('SIGTERM');
              logger.debug(`[DAEMON RUN] Sent SIGTERM to daemon-spawned session ${sessionId}`);
            } catch (error) {
              logger.debug(`[DAEMON RUN] Failed to kill session ${sessionId}:`, error);
            }
          } else {
            // For externally started sessions, try to kill by PID
            try {
              process.kill(pid, 'SIGTERM');
              logger.debug(`[DAEMON RUN] Sent SIGTERM to external session PID ${pid}`);
            } catch (error) {
              logger.debug(`[DAEMON RUN] Failed to kill external session PID ${pid}:`, error);
            }
          }

          pidToTrackedSession.delete(pid);
          logger.debug(`[DAEMON RUN] Removed session ${sessionId} from tracking`);
          return true;
        }
      }

      logger.debug(`[DAEMON RUN] Session ${sessionId} not found`);
      return false;
    };

    // Handle child process exit — preserve session data for resume
    const onChildExited = (pid: number) => {
      const session = pidToTrackedSession.get(pid);
      if (session?.happySessionId && session.encryption) {
        sessionIdToFinishedSession.set(session.happySessionId, session);
        logger.debug(`[DAEMON RUN] Process PID ${pid} exited, preserved session ${session.happySessionId} for resume`);
      } else {
        logger.debug(`[DAEMON RUN] Removing exited process PID ${pid} from tracking`);
      }
      pidToTrackedSession.delete(pid);
    };

    // Autonomous job layer (E04): durable SQLite job store + scheduler/worker
    // pool. The store is brand-new on first run; recoverOnStartup re-queues any
    // running jobs whose timeout passed while the daemon was down. The scheduler
    // claims pending jobs and spawns sessions via the same spawnSession used by
    // the app, gating local-preset jobs through a single-permit semaphore.
    const jobStore = new JobStore(join(configuration.happyHomeDir, 'jobs.db'));
    jobStore.init();
    const recoveredJobs = jobStore.recoverOnStartup(isPidAlive);
    logger.debug(`[DAEMON RUN] Job store ready; recovered ${recoveredJobs} timed-out job(s)`);
    // killSession is wired below to stopJob. The cycle (scheduler needs stopJob
    // for wall-clock kills; stopJob needs the scheduler to mark the job
    // needs-attention) is broken with a thunk: the scheduler holds an arrow that
    // calls stopJob, which is declared right after and only invoked at runtime.
    const jobScheduler = new JobScheduler({
      store: jobStore,
      localSemaphore: new Semaphore(1),
      spawn: spawnSession,
      killSession: (sessionId: string) => { stopJob(sessionId); }
    });

    // Targeted kill of an autonomous job's session: SIGTERM, then SIGKILL after
    // 5s if still alive, then mark the job needs-attention via the scheduler.
    // Returns whether a tracked session was found (mirrors stopSession's lookup).
    const stopJob = (sessionId: string): boolean => {
      let targetPid: number | undefined;
      for (const [pid, session] of pidToTrackedSession.entries()) {
        if (session.happySessionId === sessionId ||
          (sessionId.startsWith('PID-') && pid === parseInt(sessionId.replace('PID-', '')))) {
          targetPid = pid;
          break;
        }
      }
      if (targetPid === undefined) {
        logger.debug(`[DAEMON RUN] stopJob: session ${sessionId} not found`);
        return false;
      }

      try {
        process.kill(targetPid, 'SIGTERM');
        logger.debug(`[DAEMON RUN] stopJob: sent SIGTERM to PID ${targetPid} (session ${sessionId})`);
      } catch (error) {
        logger.debug(`[DAEMON RUN] stopJob: SIGTERM failed for PID ${targetPid}:`, error);
      }

      const pidToKill = targetPid;
      setTimeout(() => {
        if (isPidAlive(pidToKill)) {
          try {
            process.kill(pidToKill, 'SIGKILL');
            logger.debug(`[DAEMON RUN] stopJob: escalated to SIGKILL for PID ${pidToKill} (session ${sessionId})`);
          } catch (error) {
            logger.debug(`[DAEMON RUN] stopJob: SIGKILL failed for PID ${pidToKill}:`, error);
          }
        }
      }, 5_000);

      jobScheduler.onSessionExit(sessionId, 'killed');
      return true;
    };

    jobScheduler.start();

    // Cron layer (E04): durable SQLite schedule store + feeder. The feeder shares
    // jobs.db with the job store and, on each tick, turns due schedules into
    // pending JobRecords the scheduler then claims. The watermark is in-memory
    // (no catch-up on restart) — see CronFeeder docs.
    const cronStore = new CronStore(join(configuration.happyHomeDir, 'jobs.db'));
    cronStore.init();
    const cronFeeder = new CronFeeder({ cronStore, jobStore });
    cronFeeder.start();

    // Event layer (E04): durable SQLite subscription store sharing jobs.db. An
    // incoming event (trigger-event) is matched against enabled subscriptions and
    // each match becomes an immediately-claimable pending JobRecord. No feeder/loop
    // — events are pushed in via the trigger-event RPC / HTTP endpoint.
    const eventStore = new EventStore(join(configuration.happyHomeDir, 'jobs.db'));
    eventStore.init();

    const submitJob = (params: SubmitJobParams): string => {
      const job = buildJobFromSubmit(params, Date.now(), randomUUID());
      jobStore.create(job);
      logger.debug(`[DAEMON RUN] Created job ${job.id}`);
      return job.id;
    };

    // Cron management closures (E04). submitCron is the single canonical
    // validator (QUAL-2): it validates directory/prompt presence and the cron
    // expression before persisting an enabled schedule. The RPC and HTTP entry
    // points rely on these throws rather than re-validating. listCrons/deleteCron
    // are thin store passthroughs.
    const submitCron = (params: SubmitCronParams): string => {
      if (typeof params.directory !== 'string' || params.directory.length === 0) throw new Error('directory is required');
      if (typeof params.prompt !== 'string' || params.prompt.length === 0) throw new Error('prompt is required');
      if (typeof params.cronExpr !== 'string' || params.cronExpr.length === 0 || !validateCronExpr(params.cronExpr)) throw new Error('invalid cronExpr');
      const schedule = buildCronFromSubmit(params, Date.now(), randomUUID());
      cronStore.create(schedule);
      logger.debug(`[DAEMON RUN] Created cron schedule ${schedule.id}`);
      return schedule.id;
    };

    const listCrons = (): CronScheduleView[] => cronStore.list();

    const deleteCron = (id: string): boolean => cronStore.delete(id);

    // Event subscription management closures (E04). submitEventSubscription
    // validates the required fields before persisting an enabled subscription;
    // listEventSubscriptions/deleteEventSubscription are thin store passthroughs.
    const submitEventSubscription = (params: SubmitEventSubscriptionParams): string => {
      if (!params.eventType) throw new Error('eventType is required');
      if (!params.directory) throw new Error('directory is required');
      if (!params.prompt) throw new Error('prompt is required');
      const subscription = buildEventSubscriptionFromSubmit(params, Date.now(), randomUUID());
      eventStore.create(subscription);
      logger.debug(`[DAEMON RUN] Created event subscription ${subscription.id}`);
      return subscription.id;
    };

    const listEventSubscriptions = (): EventSubscriptionView[] => eventStore.list();

    const deleteEventSubscription = (id: string): boolean => eventStore.delete(id);

    // Deliver an event (E04). Match enabled subscriptions for the eventType (and
    // optional matchKey), then build a pending job per match and insert it
    // idempotently. With an idempotencyKey the job id is deterministic
    // (`event:{subId}:{key}`) so a re-delivery dedupes via createIfAbsent; without
    // one a random id is generated per call. The built id is collected regardless
    // of whether a new row was inserted, so the caller sees which ids were targeted.
    // A failure for one subscription is logged and skipped — it never aborts the rest.
    const triggerEvent = ({ eventType, matchKey, idempotencyKey, payload }: { eventType: string; matchKey?: string; idempotencyKey?: string; payload?: unknown }): { created: string[] } => {
      const subs = matchSubscriptions(eventStore.list(), eventType, matchKey);
      const created: string[] = [];
      for (const sub of subs) {
        try {
          const builtJob = buildEventJob(sub, payload, idempotencyKey, Date.now(), idempotencyKey ? undefined : (subId) => 'event:' + subId + ':' + randomUUID());
          const inserted = jobStore.createIfAbsent(builtJob);
          created.push(builtJob.id);
          logger.debug(`[DAEMON RUN] triggerEvent: subscription ${sub.id} -> job ${builtJob.id} (inserted: ${inserted})`);
        } catch (error) {
          logger.warn(`[DAEMON RUN] triggerEvent: subscription ${sub.id} failed:`, error);
        }
      }
      return { created };
    };

    const listJobs = (filter?: { status?: JobStatus }) =>
      jobStore.list(filter).map(toJobRecordView);

    const getJob = (id: string) => {
      const j = jobStore.get(id);
      return j ? toJobRecordView(j) : null;
    };

    const patchJobCost = (sessionId: string, costUsd: number): boolean => {
      const job = jobStore.findBySessionId(sessionId);
      if (!job) return false;
      jobStore.patch(job.id, { costUsd });
      return true;
    };

    // Cancel a non-running autonomous job (E04). A pending/retrying job has no
    // live session, so /stop-job (keyed by sessionId) cannot reach it; this drives
    // it to a terminal 'dead' state with exitReason 'cancelled'. A running job is
    // refused here — /stop-job owns killing live sessions. Returns whether a job
    // was cancelled.
    const cancelJob = (jobId: string): boolean => {
      const job = jobStore.get(jobId);
      if (!job) {
        logger.debug(`[DAEMON RUN] cancelJob: job ${jobId} not found`);
        return false;
      }
      if (job.status === 'running') {
        logger.debug(`[DAEMON RUN] cancelJob: job ${jobId} is running; use stop-job`);
        return false;
      }
      if (job.status === 'succeeded' || job.status === 'dead') {
        logger.debug(`[DAEMON RUN] cancelJob: job ${jobId} already terminal (${job.status})`);
        return false;
      }
      // pending / needs-attention -> failed -> dead; a job already 'failed'
      // (momentarily retrying) goes straight failed -> dead.
      if (job.status !== 'failed') {
        jobStore.transition(jobId, 'failed', { exitReason: 'cancelled' });
      }
      jobStore.transition(jobId, 'dead', { finishedAt: Date.now() });
      logger.debug(`[DAEMON RUN] cancelJob: job ${jobId} cancelled (was ${job.status})`);
      return true;
    };

    // Resolve a gate-parked job (E05, D-E05-4). A job the pre-spawn confidence
    // gate parked in 'needs-attention' awaits Joshua: 'approve' runs it (honouring
    // a proceed-supervised downgrade), 'reject' drives it to dead. Exposed on BOTH
    // control surfaces (HTTP + RPC) via the same scheduler method (BUG-UAT-1).
    const resolveGate = (jobId: string, decision: 'approve' | 'reject'): Promise<boolean> =>
      jobScheduler.resolveGate(jobId, decision);

    // Live-switch (AC-4): remap een gekozen set lopende cloud-sessies naar één
    // account in de authProxy — geen respawn. Fail-closed op het doel-account
    // (AC-6): doel niet ontsleutelbaar → nul remaps. Een ongebonden sessie (geen
    // routing-key) komt in `skipped`. Twee surfaces (HTTP + RPC, BUG-UAT-1) roepen
    // deze ene closure aan.
    const accountSwitch = async (sessionIds: string[], account: string): Promise<SwitchResult> => {
      const creds = await readCredentials();
      if (!creds) return { ok: false, error: 'geen credentials — switch geweigerd' };
      return applyAccountSwitch(sessionIds, { account }, {
        vaultFile: configuration.accountsVaultFile,
        masterKey: await vaultMasterKey(creds),
        proxy: authProxy,
        lookupRoutingKey: (sid) => findTrackedSessionById(sid)?.routingKey,
      });
    };

    // Usage-read (AC-5): per-account laatst-geziene 5h/7d-utilisatie die de proxy
    // uit de unified-* headers scrapte. Fail-soft (onbekend → null). Twee surfaces
    // (HTTP /usage + RPC get-usage, BUG-UAT-1) lezen deze ene snapshot.
    const getUsage = (): Record<string, AccountUsage> => usageStore.snapshot();

    // Account-management-surface (S5, D-E10-17) over de bestaande vault-CRUD. Twee
    // surfaces (HTTP + RPC, BUG-UAT-1) roepen deze closures aan zodat de app de
    // accounts kan lezen/beheren. `add-account` neemt een geheim token (van een
    // machine-side `claude setup-token`) en versleutelt het de vault in — het token
    // wordt nóóit gelogd (security.md). `list-accounts` lekt geen token (alleen metadata).
    const listAccountsVerb = (): Promise<AccountInfo[]> =>
      listAccounts(configuration.accountsVaultFile, 'claude');
    const addAccountVerb = async (name: string, token: string, isDefault?: boolean): Promise<void> => {
      const creds = await readCredentials();
      if (!creds) throw new Error('geen credentials — add-account geweigerd');
      await addAccount(configuration.accountsVaultFile, await vaultMasterKey(creds),
        { provider: 'claude', name, oauthToken: token, isDefault });
    };
    const setDefaultAccountVerb = (name: string): Promise<void> =>
      setDefaultAccount(configuration.accountsVaultFile, 'claude', name);
    const removeAccountVerb = (name: string): Promise<void> =>
      removeAccount(configuration.accountsVaultFile, 'claude', name);

    // Burn-policy (S6, AC-8, D-E10-8): instelbare burn-volgorde + drempel. Twee
    // surfaces (HTTP + RPC, BUG-UAT-1) lezen/schrijven de config op de vault.
    const getBurnPolicyVerb = (): Promise<BurnPolicyConfig> =>
      getBurnPolicy(configuration.accountsVaultFile, 'claude');
    const setBurnPolicyVerb = (config: BurnPolicyConfig): Promise<void> =>
      setBurnPolicy(configuration.accountsVaultFile, 'claude', config);

    // Monitor-tick (S6, D-E10-20): verschuift lopende cloud-sessies waarvan het
    // account de drempel raakt naar het volgende account met ruimte (via de S3-
    // accountSwitch-machinerie; geen respawn). Pure planner planBurnRemap beslist;
    // hier alleen de daemon-glue. Throwt nooit (zoals reaper): fout → volgende tick.
    const runBurnMonitorOnce = async (): Promise<void> => {
      try {
        const policy = await getBurnPolicy(configuration.accountsVaultFile, 'claude');
        if (!policy.enabled) return;
        const sessions = getCurrentChildren()
          .filter(s => s.happySessionId !== undefined && s.account !== undefined)
          .map(s => ({ sessionId: s.happySessionId!, account: s.account! }));
        if (sessions.length === 0) return;
        const plan = planBurnRemap(sessions, usageStore.snapshot(), policy);
        if (plan.length === 0) return;
        // Groepeer per doel-account → één accountSwitch per groep.
        const byTarget = new Map<string, string[]>();
        for (const { sessionId, toAccount } of plan) {
          (byTarget.get(toAccount) ?? byTarget.set(toAccount, []).get(toAccount)!).push(sessionId);
        }
        for (const [toAccount, sessionIds] of byTarget) {
          const result = await accountSwitch(sessionIds, toAccount);
          if (result.ok) {
            logger.info(`[DAEMON RUN] burn-monitor: ${result.remapped?.length ?? 0} sessie(s) → '${toAccount}' (drempel ${Math.round(policy.thresholdPct * 100)}%)`);
          } else {
            logger.warn(`[DAEMON RUN] burn-monitor: remap → '${toAccount}' faalde: ${result.error}`);
          }
        }
      } catch (error) {
        logger.warn('[DAEMON RUN] burn-monitor tick faalde (overgeslagen tot de volgende heartbeat)', error);
      }
    };

    // Sessie-projectie (gedeeld door HTTP /list én RPC list, BUG-UAT-1). Levert de
    // app de live per-sessie-account-map (gekeyd op happySessionId) voor de
    // migratie-popup; de daemon-TrackedSession is de verse bron (remap kan 'm wijzigen).
    const listSessions = (): { startedBy: string; happySessionId: string; pid: number; account?: string }[] =>
      getCurrentChildren()
        .filter(child => child.happySessionId !== undefined)
        .map(child => ({ startedBy: child.startedBy, happySessionId: child.happySessionId!, pid: child.pid, account: child.account }));

    // Start control server
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
      listSessions,
      stopSession,
      spawnSession,
      submitJob,
      stopJob,
      cancelJob,
      resolveGate,
      accountSwitch,
      getUsage,
      listAccounts: listAccountsVerb,
      addAccount: addAccountVerb,
      setDefaultAccount: setDefaultAccountVerb,
      removeAccount: removeAccountVerb,
      getBurnPolicy: getBurnPolicyVerb,
      setBurnPolicy: setBurnPolicyVerb,
      listJobs,
      getJob,
      patchJobCost,
      submitCron,
      listCrons,
      deleteCron,
      submitEventSubscription,
      listEventSubscriptions,
      deleteEventSubscription,
      triggerEvent,
      requestShutdown: () => requestShutdown('happy-cli'),
      onHappySessionWebhook
    });

    // Write initial daemon state (no lock needed for state file)
    const fileState: DaemonLocallyPersistedState = {
      pid: process.pid,
      httpPort: controlPort,
      startTime: new Date().toLocaleString(),
      startedWithCliVersion: packageJson.version,
      daemonLogPath: logger.logFilePath
    };
    writeDaemonState(fileState);
    logger.debug('[DAEMON RUN] Daemon state written');

    // Capture the bundled CLI's mtime at startup so the heartbeat can detect
    // when npm replaces `dist/index.mjs` on disk (= the user ran `npm i -g happy`).
    // We previously compared disk `package.json.version` to our bundled version,
    // but that produced infinite restart loops (#1107) when the manifest version
    // diverged from the bundled version (e.g. `happy-coder@0.13.1` deprecation
    // stub bumped package.json without rebuilding dist). File mtime is a more
    // reliable signal: it only changes when the bundle is actually replaced.
    const bundlePath = join(projectPath(), 'dist', 'index.mjs');
    let initialBundleMtimeMs = 0;
    try {
      initialBundleMtimeMs = statSync(bundlePath).mtimeMs;
    } catch {
      // dist/index.mjs not present (e.g. dev mode via tsx) — skip upgrade detection.
      logger.debug(`[DAEMON RUN] Bundle at ${bundlePath} not found; self-restart on upgrade disabled`);
    }

    // Prepare initial daemon state
    const initialDaemonState: DaemonState = {
      status: 'offline',
      pid: process.pid,
      httpPort: controlPort,
      startedAt: Date.now()
    };

    // Create API client
    const api = await ApiClient.create(credentials);

    // Available spawn profiles go into machine metadata so the app can
    // offer preset spawn. Read once at daemon start.
    const profileNames = loadProfiles().map(p => p.name);
    logger.debug(`[DAEMON RUN] Loaded ${profileNames.length} spawn profiles: ${profileNames.join(', ') || '(none)'}`);

    // Get or create machine
    const machine = await api.getOrCreateMachine({
      machineId,
      metadata: { ...initialMachineMetadata, profiles: profileNames },
      daemonState: initialDaemonState
    });
    logger.debug(`[DAEMON RUN] Machine registered: ${machine.id}`);

    // Create realtime machine session
    const apiMachine = api.machineSyncClient(machine);

    // Set RPC handlers
    apiMachine.setRPCHandlers({
      spawnSession,
      resumeSession,
      stopSession,
      requestShutdown: () => requestShutdown('happy-app'),
      submitJob,
      stopJob,
      listJobs,
      getJob,
      cancelJob,
      resolveGate,
      accountSwitch,
      getUsage,
      listAccounts: listAccountsVerb,
      addAccount: addAccountVerb,
      setDefaultAccount: setDefaultAccountVerb,
      removeAccount: removeAccountVerb,
      getBurnPolicy: getBurnPolicyVerb,
      setBurnPolicy: setBurnPolicyVerb,
      listSessions,
      submitCron,
      listCrons,
      deleteCron,
      submitEventSubscription,
      listEventSubscriptions,
      deleteEventSubscription,
      triggerEvent
    });

    // Connect to server
    apiMachine.connect();

    // Publish the current profile list. getOrCreateMachine only sets
    // metadata for brand-new machines; existing machines keep stale
    // metadata server-side until we push an update here.
    apiMachine.updateMachineMetadata((metadata) => ({
      ...(metadata ?? initialMachineMetadata),
      profiles: profileNames,
    })).catch((error) => {
      logger.debug('[DAEMON RUN] Failed to publish spawn profiles in machine metadata:', error);
    });

    // Lifecycle reaper: archive server-active sessions whose host process on
    // this machine is dead (kill -9, closed terminal, crash). Once at start
    // (reconcile after downtime), then on every heartbeat tick below.
    const reaperDeps = {
      readPersistedSessions,
      getSessions: () => api.getSessions(),
      deactivateSession: (sessionId: string) => api.deactivateSession(sessionId),
    };
    void runReaperOnce(reaperDeps);

    // Every 60 seconds:
    // 1. Prune stale sessions
    // 2. Check if daemon needs update
    // 3. If outdated, restart with latest version
    // 4. Write heartbeat
    const heartbeatIntervalMs = parseInt(process.env.HAPPY_DAEMON_HEARTBEAT_INTERVAL || '60000');
    let heartbeatRunning = false
    const restartOnStaleVersionAndHeartbeat = setInterval(async () => {
      if (heartbeatRunning) {
        return;
      }
      heartbeatRunning = true;

      if (process.env.DEBUG) {
        logger.debug(`[DAEMON RUN] Health check started at ${new Date().toLocaleString()}`);
      }

      // Prune stale sessions
      for (const [pid, _] of pidToTrackedSession.entries()) {
        try {
          // Check if process is still alive (signal 0 doesn't kill, just checks)
          process.kill(pid, 0);
        } catch (error) {
          // Process is dead, remove from tracking
          logger.debug(`[DAEMON RUN] Removing stale session with PID ${pid} (process no longer exists)`);
          pidToTrackedSession.delete(pid);
        }
      }

      // Archive server-active sessions whose host process died (see daemon/reaper.ts)
      await runReaperOnce(reaperDeps);

      // E10/S6: burn-monitor — remap lopende sessies van een (bijna-)uitgeput
      // account naar het volgende met ruimte (D-E10-20). No-op als de policy uit is.
      await runBurnMonitorOnce();

      // Check if daemon needs update by detecting whether `dist/index.mjs` was
      // replaced on disk since the daemon started (npm install rewrites the file).
      // Skip if we never captured an initial mtime (dev mode).
      let bundleReplaced = false;
      if (initialBundleMtimeMs > 0) {
        try {
          const currentMtimeMs = statSync(bundlePath).mtimeMs;
          bundleReplaced = currentMtimeMs !== initialBundleMtimeMs;
        } catch {
          // File temporarily missing (e.g. mid-install) — retry on next heartbeat.
        }
      }
      if (bundleReplaced) {
        // TODO: We probably do not want to keep this in-process self-restart logic long-term.
        // A native service manager would make startup and upgrades much simpler: the CLI would
        // ask the OS to start the latest daemon instead of hand-rolling respawn/kill behavior here.
        logger.debug('[DAEMON RUN] Daemon bundle replaced on disk, handing off to new daemon');

        clearInterval(restartOnStaleVersionAndHeartbeat);

        // Release ownership BEFORE spawning the new daemon. Otherwise the spawned
        // `happy daemon start` reads our still-present daemon.state.json, sees
        // isDaemonRunningCurrentlyInstalledHappyVersion() === true, and exits —
        // leaving nothing running once we also exit.
        apiMachine.shutdown();
        await stopControlServer();
        await cleanupDaemonState();
        await releaseDaemonLock(daemonLockHandle);
        await stopCaffeinate();

        try {
          spawnHappyCLI(['daemon', 'start'], {
            detached: true,
            stdio: 'ignore'
          });
        } catch (error) {
          logger.debug('[DAEMON RUN] Failed to spawn new daemon, this is quite likely to happen during integration tests as we are cleaning out dist/ directory', error);
        }

        process.exit(0);
      }

      // Before wrecklessly overriting the daemon state file, we should check if we are the ones who own it
      // Race condition is possible, but thats okay for the time being :D
      const daemonState = await readDaemonState();
      if (daemonState && daemonState.pid !== process.pid) {
        logger.debug('[DAEMON RUN] Somehow a different daemon was started without killing us. We should kill ourselves.')
        requestShutdown('exception', 'A different daemon was started without killing us. We should kill ourselves.')
      }

      // Heartbeat
      try {
        const updatedState: DaemonLocallyPersistedState = {
          pid: process.pid,
          httpPort: controlPort,
          startTime: fileState.startTime,
          startedWithCliVersion: packageJson.version,
          lastHeartbeat: new Date().toLocaleString(),
          daemonLogPath: fileState.daemonLogPath
        };
        writeDaemonState(updatedState);
        if (process.env.DEBUG) {
          logger.debug(`[DAEMON RUN] Health check completed at ${updatedState.lastHeartbeat}`);
        }
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to write heartbeat', error);
      }

      heartbeatRunning = false;
    }, heartbeatIntervalMs); // Every 60 seconds in production

    // Setup signal handlers
    const cleanupAndShutdown = async (source: 'happy-app' | 'happy-cli' | 'os-signal' | 'exception', errorMessage?: string) => {
      logger.debug(`[DAEMON RUN] Starting proper cleanup (source: ${source}, errorMessage: ${errorMessage})...`);

      // Clear health check interval
      if (restartOnStaleVersionAndHeartbeat) {
        clearInterval(restartOnStaleVersionAndHeartbeat);
        logger.debug('[DAEMON RUN] Health check interval cleared');
      }

      // Stop the autonomous job scheduler tick loop
      jobScheduler.stop();

      // Stop the cron feeder tick loop
      cronFeeder.stop();

      // Close the durable SQLite stores after their tick loops are stopped, so no
      // tick can run a query against a closed connection (ARCH-5).
      jobStore.close();
      cronStore.close();
      eventStore.close();

      // Update daemon state before shutting down
      await apiMachine.updateDaemonState((state: DaemonState | null) => ({
        ...state,
        status: 'shutting-down',
        shutdownRequestedAt: Date.now(),
        shutdownSource: source
      }));

      // Give time for metadata update to send
      await new Promise(resolve => setTimeout(resolve, 100));

      apiMachine.shutdown();
      await stopControlServer();
      authProxy.stop();
      await cleanupDaemonState();
      await stopCaffeinate();
      await releaseDaemonLock(daemonLockHandle);

      logger.debug('[DAEMON RUN] Cleanup completed, exiting process');
      process.exit(0);
    };

    logger.debug('[DAEMON RUN] Daemon started successfully, waiting for shutdown request');

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
  } catch (error) {
    logger.debug('[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1', error);
    process.exit(1);
  }
}
