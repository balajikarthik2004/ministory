import type { JSX } from 'react';
import { API_BASE_PATH, type HealthResponse } from '@minidrama/contracts';
import { colors } from '@minidrama/ui-tokens';

/**
 * Milestone 1.1 placeholder.
 *
 * This is scaffolding, not a product screen. It exists to prove three things
 * compile and run together: React + Vite, Tailwind v4, and the workspace
 * imports from @minidrama/contracts and @minidrama/ui-tokens.
 *
 * The real admin shell - sidebar, routing, auth - is Milestone 5.
 */
export function App(): JSX.Element {
  // Referenced so the ui-tokens workspace import is type-checked, not just
  // resolved. Replaced by real token usage in M2.
  const accent = colors.accent.primary;

  return (
    <main className="min-h-full px-6 py-10">
      <div className="mx-auto max-w-2xl">
        <p className="text-xs font-medium tracking-widest text-content-tertiary uppercase">
          Milestone 1.1
        </p>
        <h1 className="mt-2 text-2xl font-bold text-content-primary">MiniDrama Admin</h1>
        <p className="mt-2 text-sm text-content-secondary">
          Foundation scaffold. No features are implemented yet.
        </p>

        <dl className="mt-8 rounded-(--radius-card) bg-bg-card p-5 text-sm">
          <div className="flex justify-between border-b border-white/5 py-2">
            <dt className="text-content-secondary">API base path</dt>
            <dd className="font-mono text-content-primary">{API_BASE_PATH}</dd>
          </div>
          <div className="flex justify-between border-b border-white/5 py-2">
            <dt className="text-content-secondary">Health endpoint</dt>
            <dd className="font-mono text-content-primary">{`${API_BASE_PATH}/health`}</dd>
          </div>
          <div className="flex items-center justify-between py-2">
            <dt className="text-content-secondary">Accent token</dt>
            <dd className="flex items-center gap-2 font-mono text-content-primary">
              <span
                className="inline-block size-3 rounded-full"
                style={{ backgroundColor: accent }}
                aria-hidden="true"
              />
              {accent}
            </dd>
          </div>
        </dl>

        <p className="mt-6 text-xs text-content-tertiary">
          Typed against <code>HealthResponse</code> from @minidrama/contracts:{' '}
          <span className="font-mono">
            {(['status', 'service', 'version'] satisfies (keyof HealthResponse)[]).join(', ')}
          </span>
        </p>
      </div>
    </main>
  );
}
