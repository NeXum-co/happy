/**
 * Derives a stable project key from a session's working directory.
 *
 * - Paths under `~/code/<repo>/...` map to `<repo>`, with any worktree
 *   `--suffix` stripped: `~/code/control-plane--e02/...` → `control-plane`.
 * - Paths outside `~/code` (or when homeDir is unknown) fall back to the
 *   last two path segments.
 *
 * Pure function — no platform or storage dependencies.
 */
export function projectKeyFromPath(path: string, homeDir?: string | null): string {
    const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
    const segments = normalized.split('/').filter(Boolean);

    const codeRoots: string[] = ['~/code/'];
    if (homeDir) {
        const home = homeDir.replace(/\\/g, '/').replace(/\/+$/, '');
        codeRoots.push(`${home}/code/`);
    }

    for (const root of codeRoots) {
        if (normalized.startsWith(root)) {
            const repo = normalized.slice(root.length).split('/').filter(Boolean)[0];
            if (repo) {
                return repo.split('--')[0] || repo;
            }
        }
    }

    return segments.slice(-2).join('/');
}
