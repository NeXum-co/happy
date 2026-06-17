/** Shown when a session has no usable path — never a blank group title (F3). */
const UNKNOWN_PROJECT_KEY = '—';

/**
 * Derives a stable project key from a session's working directory.
 *
 * - Paths under `<homeDir>/code/<repo>/...` map to `<repo>`, with any worktree
 *   `--suffix` stripped: `<homeDir>/code/control-plane--e02/...` → `control-plane`.
 * - Paths outside the code root (or when homeDir is unknown) key on the FULL
 *   normalized path — not the last two segments, which collapse unrelated repos
 *   that share a suffix (e.g. `/opt/app/src` and `/var/app/src`) into one
 *   mislabelled group (F3).
 * - A missing/empty path yields a non-blank fallback rather than an empty title.
 *
 * Session paths are always absolute (the CLI resolves them on the host), so
 * there is no tilde-prefixed variant to handle (audit QUAL-004).
 *
 * Pure function — no platform or storage dependencies.
 */
export function projectKeyFromPath(path: string, homeDir?: string | null): string {
    const normalized = (path ?? '').replace(/\\/g, '/').replace(/\/+$/, '').trim();
    if (normalized.length === 0) {
        return UNKNOWN_PROJECT_KEY;
    }

    if (homeDir) {
        const home = homeDir.replace(/\\/g, '/').replace(/\/+$/, '');
        const root = `${home}/code/`;
        if (normalized.startsWith(root)) {
            const repo = normalized.slice(root.length).split('/').filter(Boolean)[0];
            if (repo) {
                return repo.split('--')[0] || repo;
            }
        }
    }

    return normalized;
}
