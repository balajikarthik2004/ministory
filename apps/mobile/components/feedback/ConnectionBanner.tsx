import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Easing, StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, duration as motion, radius, spacing } from '@minidrama/ui-tokens';
import { AppText } from '../primitives/AppText';
import { PressableScale } from '../primitives/PressableScale';
import { refreshSyncCounts, useSyncStore } from '../../store/sync.store';
import { getPlaybackService } from '../../services/playback/device-service';

/**
 * The offline / reconnected banner.
 *
 * UI_UX_GUIDELINES.md §5 requires offline to be a persistent banner with
 * cached content still browsable and writes queued rather than rejected —
 * which is exactly what the outbox does, so the banner's job is to say so.
 *
 * WHAT IT DOES NOT SAY. It never claims video will play offline. HLS is
 * streamed and there are no downloads in this product yet; telling a viewer
 * they can keep watching would be a lie they discover within seconds. The
 * copy is specific about what still works: browsing, and their progress
 * being kept.
 *
 * The reconnected state is deliberate. A banner that only appears on failure
 * leaves the viewer unsure whether anything recovered, so success gets a
 * brief, self-dismissing confirmation.
 */

const RECONNECTED_VISIBLE_MS = 2600;

export function ConnectionBanner(): JSX.Element | null {
  const insets = useSafeAreaInsets();
  const online = useSyncStore((state) => state.online);
  const pendingCount = useSyncStore((state) => state.pendingCount);
  const syncing = useSyncStore((state) => state.syncing);
  const justReconnected = useSyncStore((state) => state.justReconnected);
  const clearReconnected = useSyncStore((state) => state.clearReconnected);

  const [slide] = useState(() => new Animated.Value(0));
  const visible = !online || justReconnected;

  useEffect(() => {
    Animated.timing(slide, {
      toValue: visible ? 1 : 0,
      duration: motion.base,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [slide, visible]);

  useEffect(() => {
    if (!justReconnected) return;
    const timer = setTimeout(clearReconnected, RECONNECTED_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [clearReconnected, justReconnected]);

  if (!visible) return null;

  const retry = (): void => {
    void (async () => {
      useSyncStore.getState().setSyncing(true);
      try {
        const service = await getPlaybackService();
        await service.sync.run();
      } catch {
        // The outcome subscription clears the spinner either way.
      } finally {
        useSyncStore.getState().setSyncing(false);
        await refreshSyncCounts();
      }
    })();
  };

  const offlineDetail =
    pendingCount > 0
      ? `Browsing still works. ${pendingCount} ${pendingCount === 1 ? 'update' : 'updates'} will sync when you reconnect.`
      : 'Browsing still works. New episodes need a connection.';

  return (
    <Animated.View
      style={[
        styles.container,
        { paddingTop: insets.top + spacing.sm },
        {
          opacity: slide,
          transform: [
            { translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [-24, 0] }) },
          ],
        },
        online ? styles.restored : styles.offline,
      ]}
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
    >
      <Ionicons
        name={online ? 'cloud-done-outline' : 'cloud-offline-outline'}
        size={18}
        color={online ? colors.status.success : colors.status.warning}
      />

      <View style={styles.text}>
        <AppText variant="caption" tone="primary">
          {online ? 'Back online' : "You're offline"}
        </AppText>
        <AppText variant="micro" tone="secondary">
          {online ? 'Catching up on anything saved while you were away.' : offlineDetail}
        </AppText>
      </View>

      {!online && pendingCount > 0 ? (
        <PressableScale
          onPress={retry}
          activeScale={0.94}
          accessibilityRole="button"
          accessibilityLabel="Try syncing now"
          style={styles.action}
          disabled={syncing}
        >
          {syncing ? (
            <ActivityIndicator size="small" color={colors.accent.primary} />
          ) : (
            <AppText variant="micro" tone="accent">
              Retry
            </AppText>
          )}
        </PressableScale>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    // Above the top scrim, below a full-screen modal — the player draws its
    // own chrome and must not be interrupted by a banner over the video.
    zIndex: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  offline: {
    backgroundColor: colors.bg.elevated,
    borderBottomColor: colors.border.strong,
  },
  restored: {
    backgroundColor: colors.bg.elevated,
    borderBottomColor: colors.status.success,
  },
  text: {
    flex: 1,
    gap: 1,
  },
  action: {
    minHeight: 32,
    minWidth: 56,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border.strong,
  },
});
