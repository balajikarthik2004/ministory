import type { JSX } from 'react';
import { Redirect, Stack } from 'expo-router';
import { colors } from '@minidrama/ui-tokens';

/**
 * Dev-only route group for the M1.2 video player spike.
 *
 * Gated on __DEV__ so the experiments cannot be reached from a release build
 * even though they are compiled into the bundle. The spike is throwaway code
 * (docs/VIDEO_PLAYER_SPIKE.md) and must never be mistaken for the product.
 */
export default function ExperimentsLayout(): JSX.Element {
  if (!__DEV__) return <Redirect href="/" />;

  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerStyle: { backgroundColor: colors.bg.secondary },
        headerTintColor: colors.text.primary,
        headerTitleStyle: { color: colors.text.primary },
        contentStyle: { backgroundColor: colors.bg.primary },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Player spike' }} />
      <Stack.Screen name="[experiment]" options={{ title: 'Experiment' }} />
    </Stack>
  );
}
