/**
 * Generate temporary settings file with Claude hooks for session tracking
 *
 * Creates a settings.json file that configures Claude's SessionStart hook
 * to notify our HTTP server when sessions change (new session, resume, compact, etc.)
 *
 * Also wires the local-attention hooks (E02 AC-6): Notification signals a
 * terminal permission prompt; PostToolUse / UserPromptSubmit / Stop signal
 * that the prompt was answered. All events go through the same forwarder,
 * which routes them on hook_event_name.
 */

import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { projectPath } from '@/projectPath';

/**
 * Generate a per-session shared secret for the hook server (SEC-001).
 * Lives in memory and in the user-only settings file — nowhere else on disk.
 */
export function generateHookSecret(): string {
    return randomBytes(32).toString('hex');
}

/**
 * Generate a temporary settings file with SessionStart hook configuration
 *
 * @param port - The port where Happy server is listening
 * @param secret - Per-session shared secret the forwarder must echo back (SEC-001)
 * @returns Path to the generated settings file
 */
export function generateHookSettingsFile(port: number, secret: string): string {
    const hooksDir = join(configuration.happyHomeDir, 'tmp', 'hooks');
    mkdirSync(hooksDir, { recursive: true });

    // Unique filename per process to avoid conflicts
    const filename = `session-hook-${process.pid}.json`;
    const filepath = join(hooksDir, filename);

    // Path to the hook forwarder script
    const forwarderScript = resolve(projectPath(), 'scripts', 'session_hook_forwarder.cjs');
    const hookCommand = `node "${forwarderScript}" ${port} ${secret}`;

    const forwarderHook = {
        matcher: "*",
        hooks: [
            {
                type: "command",
                command: hookCommand
            }
        ]
    };

    const settings = {
        hooks: {
            SessionStart: [forwarderHook],
            // Local-attention events (E02 AC-6). Notification = terminal
            // permission prompt pending; the others mean it's answered.
            // PermissionDenied is the only event fired on deny/Esc.
            // Notification / UserPromptSubmit / Stop take no matcher in
            // Claude Code, but a "*" matcher entry is accepted everywhere.
            Notification: [forwarderHook],
            PostToolUse: [forwarderHook],
            UserPromptSubmit: [forwarderHook],
            Stop: [forwarderHook],
            PermissionDenied: [forwarderHook]
        }
    };

    writeFileSync(filepath, JSON.stringify(settings, null, 2));
    logger.debug(`[generateHookSettings] Created hook settings file: ${filepath}`);

    return filepath;
}

/**
 * Clean up the temporary hook settings file
 * 
 * @param filepath - Path to the settings file to remove
 */
export function cleanupHookSettingsFile(filepath: string): void {
    try {
        if (existsSync(filepath)) {
            unlinkSync(filepath);
            logger.debug(`[generateHookSettings] Cleaned up hook settings file: ${filepath}`);
        }
    } catch (error) {
        logger.debug(`[generateHookSettings] Failed to cleanup hook settings file: ${error}`);
    }
}

