/**
 * Derives a stable project key from a session's working directory.
 *
 * - Paths under `<homeDir>/code/<repo>/...` map to `<repo>`, with any worktree
 *   `--suffix` stripped: `<homeDir>/code/control-plane--e02/...` → `control-plane`.
 * - Paths outside the code root (or when homeDir is unknown) fall back to the
 *   last two path segments.
 *
 * Session paths are always absolute (the CLI resolves them on the host), so
 * there is no tilde-prefixed variant to handle (audit QUAL-004).
 *
 * Pure function — no platform or storage dependencies.
 */
export function projectKeyFromPath(path: string, homeDir?: string | null): string {
    const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
    const segments = normalized.split('/').filter(Boolean);

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

    return segments.slice(-2).join('/');
}
