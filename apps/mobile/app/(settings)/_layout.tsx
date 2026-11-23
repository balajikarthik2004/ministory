import type { JSX } from 'react';
import { Stack } from 'expo-router';
import { colors } from '@minidrama/ui-tokens';

/**
 * The settings route group (M2.6).
 *
 * A SIBLING OF `(auth)`, NOT A CHILD OF `(tabs)`. Account deletion is a task
 * the viewer steps into from Profile and either finishes or abandons — it is
 * not a place in the app, and it must not keep the bottom tab bar, which
 * would invite wandering off mid-flow into a half-deleted state.
 *
 * Parenthesised, so the URLs stay `/delete-account` and
 * `/delete-account/confirm`, which is what keeps them linkable from a
 * notification or a support reply later without a route rename.
 */
export default function SettingsLayout(): JSX.Element {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg.primary },
        animation: 'slide_from_right',
      }}
    />
  );
}
