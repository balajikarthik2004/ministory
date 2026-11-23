import type { JSX } from 'react';
import { Stack } from 'expo-router';
import { colors } from '@minidrama/ui-tokens';

/**
 * The authentication route group.
 *
 * A GROUP RATHER THAN FOUR TOP-LEVEL ROUTES so these screens share one stack
 * with one set of options, and so `/login` stays the URL — a group's
 * parenthesised name does not appear in the path, which is what keeps the
 * deep link in a reset email (`minidrama://auth/reset-password`) matching the
 * route (`/reset-password`).
 *
 * No headers: every screen here uses `AuthScreenLayout`, which draws its own
 * back control inside the safe area and over the dark palette.
 */
export default function AuthLayout(): JSX.Element {
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
