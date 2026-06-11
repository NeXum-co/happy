/**
 * Unit tests for tmux utilities
 *
 * NOTE: These are pure unit tests that test parsing and validation logic.
 * They do NOT require tmux to be installed on the system.
 * All tests mock environment variables and test string parsing only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    parseTmuxSessionIdentifier,
    formatTmuxSessionIdentifier,
    validateTmuxSessionIdentifier,
    buildTmuxSessionIdentifier,
    TmuxSessionIdentifierError,
    TmuxUtilities,
    type TmuxSessionIdentifier,
} from './tmux';

describe('parseTmuxSessionIdentifier', () => {
    it('should parse session-only identifier', () => {
        const result = parseTmuxSessionIdentifier('my-session');
        expect(result).toEqual({
            session: 'my-session'
        });
    });

    it('should parse session:window identifier', () => {
        const result = parseTmuxSessionIdentifier('my-session:window-1');
        expect(result).toEqual({
            session: 'my-session',
            window: 'window-1'
        });
    });

    it('should parse session:window.pane identifier', () => {
        const result = parseTmuxSessionIdentifier('my-session:window-1.2');
        expect(result).toEqual({
            session: 'my-session',
            window: 'window-1',
            pane: '2'
        });
    });

    it('should handle session names with dots, hyphens, and underscores', () => {
        const result = parseTmuxSessionIdentifier('my.test_session-1');
        expect(result).toEqual({
            session: 'my.test_session-1'
        });
    });

    it('should handle window names with hyphens and underscores', () => {
        const result = parseTmuxSessionIdentifier('session:my_test-window-1');
        expect(result).toEqual({
            session: 'session',
            window: 'my_test-window-1'
        });
    });

    it('should throw on empty string', () => {
        expect(() => parseTmuxSessionIdentifier('')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('')).toThrow('Session identifier must be a non-empty string');
    });

    it('should throw on null/undefined', () => {
        expect(() => parseTmuxSessionIdentifier(null as any)).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier(undefined as any)).toThrow(TmuxSessionIdentifierError);
    });

    it('should throw on invalid session name characters', () => {
        expect(() => parseTmuxSessionIdentifier('invalid session')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('invalid session')).toThrow('Only alphanumeric characters, dots, hyphens, and underscores are allowed');
    });

    it('should throw on special characters in session name', () => {
        expect(() => parseTmuxSessionIdentifier('session@name')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('session#name')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('session$name')).toThrow(TmuxSessionIdentifierError);
    });

    it('should throw on invalid window name characters', () => {
        expect(() => parseTmuxSessionIdentifier('session:invalid window')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('session:invalid window')).toThrow('Only alphanumeric characters, dots, hyphens, and underscores are allowed');
    });

    it('should throw on non-numeric pane identifier', () => {
        expect(() => parseTmuxSessionIdentifier('session:window.abc')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('session:window.abc')).toThrow('Only numeric values are allowed');
    });

    it('should throw on pane identifier with special characters', () => {
        expect(() => parseTmuxSessionIdentifier('session:window.1a')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('session:window.-1')).toThrow(TmuxSessionIdentifierError);
    });

    it('should trim whitespace from components', () => {
        const result = parseTmuxSessionIdentifier('session : window . 2');
        expect(result).toEqual({
            session: 'session',
            window: 'window',
            pane: '2'
        });
    });
});

describe('formatTmuxSessionIdentifier', () => {
    it('should format session-only identifier', () => {
        const identifier: TmuxSessionIdentifier = { session: 'my-session' };
        expect(formatTmuxSessionIdentifier(identifier)).toBe('my-session');
    });

    it('should format session:window identifier', () => {
        const identifier: TmuxSessionIdentifier = {
            session: 'my-session',
            window: 'window-1'
        };
        expect(formatTmuxSessionIdentifier(identifier)).toBe('my-session:window-1');
    });

    it('should format session:window.pane identifier', () => {
        const identifier: TmuxSessionIdentifier = {
            session: 'my-session',
            window: 'window-1',
            pane: '2'
        };
        expect(formatTmuxSessionIdentifier(identifier)).toBe('my-session:window-1.2');
    });

    it('should ignore pane when window is not provided', () => {
        const identifier: TmuxSessionIdentifier = {
            session: 'my-session',
            pane: '2'
        };
        expect(formatTmuxSessionIdentifier(identifier)).toBe('my-session');
    });

    it('should throw when session is missing', () => {
        const identifier: TmuxSessionIdentifier = { session: '' };
        expect(() => formatTmuxSessionIdentifier(identifier)).toThrow(TmuxSessionIdentifierError);
        expect(() => formatTmuxSessionIdentifier(identifier)).toThrow('Session identifier must have a session name');
    });

    it('should handle complex valid names', () => {
        const identifier: TmuxSessionIdentifier = {
            session: 'my.test_session-1',
            window: 'my_test-window-2',
            pane: '3'
        };
        expect(formatTmuxSessionIdentifier(identifier)).toBe('my.test_session-1:my_test-window-2.3');
    });
});

describe('validateTmuxSessionIdentifier', () => {
    it('should return valid:true for valid session-only identifier', () => {
        const result = validateTmuxSessionIdentifier('my-session');
        expect(result).toEqual({ valid: true });
    });

    it('should return valid:true for valid session:window identifier', () => {
        const result = validateTmuxSessionIdentifier('my-session:window-1');
        expect(result).toEqual({ valid: true });
    });

    it('should return valid:true for valid session:window.pane identifier', () => {
        const result = validateTmuxSessionIdentifier('my-session:window-1.2');
        expect(result).toEqual({ valid: true });
    });

    it('should return valid:false for empty string', () => {
        const result = validateTmuxSessionIdentifier('');
        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
    });

    it('should return valid:false for invalid session characters', () => {
        const result = validateTmuxSessionIdentifier('invalid session');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Only alphanumeric characters');
    });

    it('should return valid:false for invalid window characters', () => {
        const result = validateTmuxSessionIdentifier('session:invalid window');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Only alphanumeric characters');
    });

    it('should return valid:false for invalid pane identifier', () => {
        const result = validateTmuxSessionIdentifier('session:window.abc');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Only numeric values are allowed');
    });

    it('should handle complex valid identifiers', () => {
        const result = validateTmuxSessionIdentifier('my.test_session-1:my_test-window-2.3');
        expect(result).toEqual({ valid: true });
    });

    it('should not throw exceptions', () => {
        expect(() => validateTmuxSessionIdentifier('')).not.toThrow();
        expect(() => validateTmuxSessionIdentifier('invalid session')).not.toThrow();
        expect(() => validateTmuxSessionIdentifier(null as any)).not.toThrow();
    });
});

describe('buildTmuxSessionIdentifier', () => {
    it('should build session-only identifier', () => {
        const result = buildTmuxSessionIdentifier({ session: 'my-session' });
        expect(result).toEqual({
            success: true,
            identifier: 'my-session'
        });
    });

    it('should build session:window identifier', () => {
        const result = buildTmuxSessionIdentifier({
            session: 'my-session',
            window: 'window-1'
        });
        expect(result).toEqual({
            success: true,
            identifier: 'my-session:window-1'
        });
    });

    it('should build session:window.pane identifier', () => {
        const result = buildTmuxSessionIdentifier({
            session: 'my-session',
            window: 'window-1',
            pane: '2'
        });
        expect(result).toEqual({
            success: true,
            identifier: 'my-session:window-1.2'
        });
    });

    it('should return error for empty session name', () => {
        const result = buildTmuxSessionIdentifier({ session: '' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid session name');
    });

    it('should return error for invalid session characters', () => {
        const result = buildTmuxSessionIdentifier({ session: 'invalid session' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid session name');
    });

    it('should return error for invalid window characters', () => {
        const result = buildTmuxSessionIdentifier({
            session: 'session',
            window: 'invalid window'
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid window name');
    });

    it('should return error for invalid pane identifier', () => {
        const result = buildTmuxSessionIdentifier({
            session: 'session',
            window: 'window',
            pane: 'abc'
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid pane identifier');
    });

    it('should handle complex valid inputs', () => {
        const result = buildTmuxSessionIdentifier({
            session: 'my.test_session-1',
            window: 'my_test-window-2',
            pane: '3'
        });
        expect(result).toEqual({
            success: true,
            identifier: 'my.test_session-1:my_test-window-2.3'
        });
    });

    it('should not throw exceptions for invalid inputs', () => {
        expect(() => buildTmuxSessionIdentifier({ session: '' })).not.toThrow();
        expect(() => buildTmuxSessionIdentifier({ session: 'invalid session' })).not.toThrow();
        expect(() => buildTmuxSessionIdentifier({ session: null as any })).not.toThrow();
    });
});

describe('TmuxUtilities.detectTmuxEnvironment', () => {
    const originalTmuxEnv = process.env.TMUX;

    // Helper to set and restore environment
    const withTmuxEnv = (value: string | undefined, fn: () => void) => {
        process.env.TMUX = value;
        try {
            fn();
        } finally {
            if (originalTmuxEnv !== undefined) {
                process.env.TMUX = originalTmuxEnv;
            } else {
                delete process.env.TMUX;
            }
        }
    };

    it('should return null when TMUX env is not set', () => {
        withTmuxEnv(undefined, () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            expect(result).toBeNull();
        });
    });

    it('should parse valid TMUX environment variable', () => {
        withTmuxEnv('/tmp/tmux-1000/default,4219,0', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            expect(result).toEqual({
                session: '4219',
                window: '0',
                pane: '0',
                socket_path: '/tmp/tmux-1000/default'
            });
        });
    });

    it('should parse TMUX env with session.window format', () => {
        withTmuxEnv('/tmp/tmux-1000/default,mysession.mywindow,2', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            expect(result).toEqual({
                session: 'mysession',
                window: 'mywindow',
                pane: '2',
                socket_path: '/tmp/tmux-1000/default'
            });
        });
    });

    it('should handle TMUX env without session.window format', () => {
        withTmuxEnv('/tmp/tmux-1000/default,session123,1', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            expect(result).toEqual({
                session: 'session123',
                window: '0',
                pane: '1',
                socket_path: '/tmp/tmux-1000/default'
            });
        });
    });

    it('should handle complex socket paths correctly', () => {
        // CRITICAL: Test that path parsing works with the fixed array indexing
        withTmuxEnv('/tmp/tmux-1000/my-socket,5678,3', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            expect(result).toEqual({
                session: '5678',
                window: '0',
                pane: '3',
                socket_path: '/tmp/tmux-1000/my-socket'
            });
        });
    });

    it('should handle socket path with multiple slashes', () => {
        // Test the array indexing fix - ensure we get the last component correctly
        withTmuxEnv('/var/run/tmux/1000/default,session.window,0', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            expect(result).toEqual({
                session: 'session',
                window: 'window',
                pane: '0',
                socket_path: '/var/run/tmux/1000/default'
            });
        });
    });

    it('should return null for malformed TMUX env (too few parts)', () => {
        withTmuxEnv('/tmp/tmux-1000/default,4219', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            expect(result).toBeNull();
        });
    });

    it('should return null for malformed TMUX env (empty string)', () => {
        withTmuxEnv('', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            expect(result).toBeNull();
        });
    });

    it('should handle TMUX env with extra parts (more than 3 comma-separated values)', () => {
        withTmuxEnv('/tmp/tmux-1000/default,4219,0,extra', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            // Should still parse the first 3 parts correctly
            expect(result).toEqual({
                session: '4219',
                window: '0',
                pane: '0',
                socket_path: '/tmp/tmux-1000/default'
            });
        });
    });

    it('should handle edge case with dots in session identifier', () => {
        withTmuxEnv('/tmp/tmux-1000/default,my.session.name.5,2', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            // Split on dot, so my.session becomes session=my, window=session
            expect(result).toEqual({
                session: 'my',
                window: 'session',
                pane: '2',
                socket_path: '/tmp/tmux-1000/default'
            });
        });
    });
});

describe('tmux argument order (regression: tmux stops option parsing at first non-option argument)', () => {
    // Mocks the private runCommand so no tmux binary is needed; these tests
    // verify the CONSTRUCTED argv only. Regression for the preset-spawn bug
    // where -P/-F/-t ended up AFTER the shell command, so tmux treated them
    // as part of the command to execute: the window crashed instantly and
    // new-window printed no pane PID ("Failed to extract PID from tmux output").
    afterEach(() => {
        vi.restoreAllMocks();
    });

    const mockRunCommand = (utils: TmuxUtilities, calls: string[][]) => {
        vi.spyOn(utils as any, 'runCommand').mockImplementation(async (...mockArgs: unknown[]) => {
            const argv = mockArgs[0] as string[];
            calls.push(argv);
            if (argv.includes('new-window')) {
                // Simulate tmux printing the pane PID via -P -F '#{pane_pid}'
                return { exitCode: 0, stdout: '12345\n', stderr: '' };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        });
    };

    it('executeTmuxCommand inserts -t directly after the subcommand, never after trailing arguments', async () => {
        const utils = new TmuxUtilities('test-session');
        const calls: string[][] = [];
        mockRunCommand(utils, calls);

        await utils.executeTmuxCommand(['new-window', '-n', 'win', 'echo hi; sleep 30']);

        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual([
            'tmux', 'new-window', '-t', 'test-session', '-n', 'win', 'echo hi; sleep 30'
        ]);
    });

    it('spawnInTmux places -P, -F and -t before the shell command (shell command is the last argument)', async () => {
        const utils = new TmuxUtilities('test-session');
        const calls: string[][] = [];
        mockRunCommand(utils, calls);

        const result = await utils.spawnInTmux(['node', 'index.mjs', 'claude'], {
            sessionName: 'test-session',
            windowName: 'my-window',
            cwd: '/tmp'
        }, { FOO: 'bar' });

        expect(result).toEqual({
            success: true,
            sessionId: 'test-session:my-window',
            pid: 12345
        });

        const newWindowCmd = calls.find(argv => argv.includes('new-window'));
        expect(newWindowCmd).toBeDefined();

        // The shell command must be the LAST argument: tmux stops option
        // parsing at the first non-option argument.
        const shellCommandIndex = newWindowCmd!.indexOf('node index.mjs claude');
        expect(shellCommandIndex).toBe(newWindowCmd!.length - 1);

        // All flags must come before the shell command.
        const pIndex = newWindowCmd!.indexOf('-P');
        expect(pIndex).toBeGreaterThan(-1);
        expect(pIndex).toBeLessThan(shellCommandIndex);

        const fIndex = newWindowCmd!.indexOf('-F');
        expect(fIndex).toBeGreaterThan(-1);
        expect(fIndex).toBeLessThan(shellCommandIndex);
        expect(newWindowCmd![fIndex + 1]).toBe('#{pane_pid}');

        const tIndex = newWindowCmd!.indexOf('-t');
        expect(tIndex).toBeGreaterThan(-1);
        expect(tIndex).toBeLessThan(shellCommandIndex);
        expect(newWindowCmd![tIndex + 1]).toBe('test-session');

        // Environment flag also stays before the shell command.
        const eIndex = newWindowCmd!.indexOf('-e');
        expect(eIndex).toBeGreaterThan(-1);
        expect(eIndex).toBeLessThan(shellCommandIndex);
        expect(newWindowCmd![eIndex + 1]).toBe('FOO=bar');
    });

    it('spawnInTmux passes environment values verbatim — tmux -e does not strip shell quoting', async () => {
        // Regression: values were wrapped in double quotes and shell-escaped,
        // but tmux sets -e values verbatim in the window environment (no shell
        // parses them). The spawned process then saw HAPPY_HOME_DIR="..." with
        // literal quotes and could not find its credentials.
        const utils = new TmuxUtilities('test-session');
        const calls: string[][] = [];
        mockRunCommand(utils, calls);

        await utils.spawnInTmux(['echo', 'hi'], {
            sessionName: 'test-session',
            windowName: 'my-window'
        }, {
            HAPPY_HOME_DIR: '/tmp/happy-e02c',
            WITH_SPECIALS: 'a"b\\c$d`e'
        });

        const newWindowCmd = calls.find(argv => argv.includes('new-window'))!;
        const envValues = newWindowCmd
            .map((arg, i) => (newWindowCmd[i - 1] === '-e' ? arg : null))
            .filter((arg): arg is string => arg !== null);
        expect(envValues).toEqual([
            'HAPPY_HOME_DIR=/tmp/happy-e02c',
            'WITH_SPECIALS=a"b\\c$d`e'
        ]);
    });
});

describe('Round-trip consistency', () => {
    it('should parse and format consistently for session-only', () => {
        const original = 'my-session';
        const parsed = parseTmuxSessionIdentifier(original);
        const formatted = formatTmuxSessionIdentifier(parsed);
        expect(formatted).toBe(original);
    });

    it('should parse and format consistently for session:window', () => {
        const original = 'my-session:window-1';
        const parsed = parseTmuxSessionIdentifier(original);
        const formatted = formatTmuxSessionIdentifier(parsed);
        expect(formatted).toBe(original);
    });

    it('should parse and format consistently for session:window.pane', () => {
        const original = 'my-session:window-1.2';
        const parsed = parseTmuxSessionIdentifier(original);
        const formatted = formatTmuxSessionIdentifier(parsed);
        expect(formatted).toBe(original);
    });

    it('should build and parse consistently', () => {
        const params = {
            session: 'my-session',
            window: 'window-1',
            pane: '2'
        };
        const built = buildTmuxSessionIdentifier(params);
        expect(built.success).toBe(true);
        const parsed = parseTmuxSessionIdentifier(built.identifier!);
        expect(parsed).toEqual(params);
    });
});
