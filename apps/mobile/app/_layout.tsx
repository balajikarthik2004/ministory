import type { JSX } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { colors } from '@minidrama/ui-tokens';

/**
 * Root layout.
 *
 * Milestone 1.1 scaffold: a single stack with the header hidden. The real route
 * groups - (auth), (tabs) and the (player) modal - arrive in Milestone 2
 * (docs/DEVELOPMENT_ROADMAP.md §3).
 */
export default function RootLayout(): JSX.Element {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg.primary },
        }}
      />
    </SafeAreaProvider>
  );
}
