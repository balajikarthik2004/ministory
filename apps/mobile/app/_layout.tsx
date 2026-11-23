import type { JSX } from 'react';
import { Stack, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClientProvider } from '@tanstack/react-query';
import { colors } from '@minidrama/ui-tokens';
import { queryClient } from '../services/query-client';
import { usePlaybackBootstrap } from '../services/playback/use-playback-bootstrap';
import { ConnectionBanner } from '../components/feedback/ConnectionBanner';

/**
 * Root layout.
 *
 * Route structure:
 *
 *   index            splash + session restore, then onboarding or the tabs
 *   (auth)/          login · register · forgot/reset password · verify · onboarding
 *   (settings)/      account deletion (M2.6), reached from Profile
 *   (tabs)/          home · search · my-list · profile, with the bottom bar
 *   drama/[slug]     drama detail, pushed over the tabs
 *   player/[slug]    full-screen player — no tab bar, by design
 *   (experiments)/   dev-only M1.2 spike, gated on __DEV__
 *
 * The player is a sibling of the tab group rather than a screen inside it,
 * which is what keeps the bottom bar off a full-bleed video. It presents
 * modally so the gesture to leave it matches the swipe-down the overlay's
 * close button mirrors.
 *
 * M2.2 adds the playback pipeline here: it is started once, for the life of
 * the app, above the navigator so a route change cannot restart it.
 *
 * THE AUTH GROUP IS A SIBLING OF THE TABS, NOT A GATE IN FRONT OF THEM.
 * Guest browsing is P0 (PRD AUTH-03): the catalogue, search and free playback
 * all work with no account, so there is no route guard here. Sign-in is
 * reached from Profile or from an action that needs an account, and the
 * screens present from the bottom because they are a task the viewer stepped
 * into, not a place they navigated to.
 */
export default function RootLayout(): JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider>
        {/* Light content over the dark palette everywhere; the player draws
            edge-to-edge beneath it (UI_UX_GUIDELINES.md §2). */}
        <StatusBar style="light" />

        {/* Opens the database, recovers the outbox, hydrates progress and
            watches connectivity. Renders nothing. */}
        <PlaybackPipeline />

        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.bg.primary },
            animation: 'slide_from_right',
          }}
        >
          <Stack.Screen name="index" options={{ animation: 'fade' }} />
          <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
          <Stack.Screen name="(auth)" options={{ animation: 'slide_from_bottom' }} />
          <Stack.Screen name="(settings)" options={{ animation: 'slide_from_bottom' }} />
          <Stack.Screen name="drama/[slug]" />
          <Stack.Screen
            name="player/[slug]"
            options={{
              presentation: 'fullScreenModal',
              animation: 'slide_from_bottom',
              // The player manages its own safe-area insets so the video can
              // run under the status bar.
              statusBarHidden: false,
            }}
          />
        </Stack>

        <OfflineIndicator />
      </SafeAreaProvider>
    </QueryClientProvider>
  );
}

/** Hosts the pipeline's lifecycle hook without rendering anything. */
function PlaybackPipeline(): null {
  usePlaybackBootstrap();
  return null;
}

/**
 * The connection banner, everywhere except the player.
 *
 * It sits above the navigator so it survives route changes rather than being
 * re-mounted per screen. The player is the one exception: a banner dropping
 * over full-bleed video would cover the frame and the overlay's own controls,
 * and a viewer mid-episode cannot act on it anyway. The player's own error
 * and retry state already covers the case that matters there.
 */
function OfflineIndicator(): JSX.Element | null {
  const pathname = usePathname();
  if (pathname.startsWith('/player')) return null;
  return <ConnectionBanner />;
}
