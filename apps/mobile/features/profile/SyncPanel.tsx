import type { JSX } from 'react';
import { StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors, radius, spacing } from '@minidrama/ui-tokens';
import { AppText } from '../../components/primitives/AppText';
import { Badge } from '../../components/primitives/Badge';
import { Button } from '../../components/primitives/Button';
import { Chip } from '../../components/primitives/Chip';
import { SectionHeader } from '../../components/feedback/SectionHeader';
import type { MockFailureMode } from '../../services/playback/sync/adapter';
import {
  discardDeadEvents,
  setSyncFailureMode,
  syncNow,
  useSyncStore,
} from '../../store/sync.store';

/**
 * The playback queue, made visible.
 *
 * Two audiences. For a viewer, "3 events waiting" explains why their progress
 * has not appeared on another device yet, which is otherwise invisible and
 * reads as a bug. For a developer, the failure-mode controls are how the
 * retry and backoff paths get exercised on real hardware — those are the
 * parts most likely to be wrong and least likely to be hit by accident.
 *
 * A pure reader: every value comes from the sync store and every action is a
 * store function. No effects, so it cannot cascade renders, and nothing here
 * reaches into the service directly.
 */

const FAILURE_MODES: ReadonlyArray<{ mode: MockFailureMode; label: string; hint: string }> = [
  { mode: 'none', label: 'Normal', hint: 'Everything is accepted' },
  { mode: 'transport', label: 'Server down', hint: 'Send fails cleanly; events are requeued' },
  { mode: 'ambiguous', label: 'No response', hint: 'Stored but unconfirmed — tests deduplication' },
  { mode: 'partial', label: 'Partial accept', hint: 'Half the batch; the rest stay queued' },
  { mode: 'reject', label: 'Rejected', hint: 'Not retryable; burns attempts down to dead' },
];

export function SyncPanel(): JSX.Element {
  const online = useSyncStore((state) => state.online);
  const pendingCount = useSyncStore((state) => state.pendingCount);
  const deadCount = useSyncStore((state) => state.deadCount);
  const syncing = useSyncStore((state) => state.syncing);
  const adapterName = useSyncStore((state) => state.adapterName);
  const delivered = useSyncStore((state) => state.deliveredThisSession);
  const failureMode = useSyncStore((state) => state.failureMode);
  const adapterIsMock = useSyncStore((state) => state.adapterIsMock);

  return (
    <View style={styles.section}>
      <SectionHeader
        title="Playback sync"
        subtitle="Watch progress and playback events waiting to upload"
      />

      <View style={styles.card}>
        <View style={styles.statusRow}>
          <Ionicons
            name={online ? 'cloud-done-outline' : 'cloud-offline-outline'}
            size={20}
            color={online ? colors.status.success : colors.status.warning}
          />
          <View style={styles.statusText}>
            <AppText variant="bodyStrong">{online ? 'Connected' : 'Offline'}</AppText>
            <AppText variant="micro" tone="tertiary">
              {pendingCount === 0
                ? 'Everything is up to date.'
                : `${pendingCount} ${pendingCount === 1 ? 'event' : 'events'} waiting to upload.`}
            </AppText>
          </View>
          {pendingCount > 0 ? <Badge label={String(pendingCount)} tone="accent" /> : null}
        </View>

        {deadCount > 0 ? (
          <>
            <View style={styles.divider} />
            <View style={styles.statusRow}>
              <Ionicons name="warning-outline" size={20} color={colors.status.error} />
              <View style={styles.statusText}>
                <AppText variant="bodyStrong" tone="error">
                  {`${deadCount} ${deadCount === 1 ? 'event' : 'events'} gave up`}
                </AppText>
                <AppText variant="micro" tone="tertiary">
                  Kept so they can be inspected rather than silently dropped.
                </AppText>
              </View>
            </View>
          </>
        ) : null}

        <View style={styles.divider} />

        <View style={styles.actions}>
          <Button
            label={syncing ? 'Syncing…' : 'Sync now'}
            icon="sync"
            variant="secondary"
            size="sm"
            loading={syncing}
            onPress={() => void syncNow()}
            style={styles.actionButton}
          />
          {deadCount > 0 ? (
            <Button
              label="Discard failed"
              variant="ghost"
              size="sm"
              onPress={() => void discardDeadEvents()}
              style={styles.actionButton}
            />
          ) : null}
        </View>
      </View>

      {__DEV__ && adapterIsMock ? (
        <View style={styles.devBlock}>
          <View style={styles.devHeader}>
            <Ionicons name="construct-outline" size={14} color={colors.status.warning} />
            <AppText variant="micro" tone="secondary" style={styles.flex}>
              {`${adapterName} · ${delivered} delivered this session`}
            </AppText>
          </View>

          <AppText variant="micro" tone="tertiary" style={styles.devNote}>
            Pick a failure, then press Sync now. Nothing is lost: events are requeued with a growing
            backoff and only give up after eight attempts, at which point they are shown above
            rather than deleted.
          </AppText>

          <View style={styles.modes}>
            {FAILURE_MODES.map((entry) => (
              <Chip
                key={entry.mode}
                label={entry.label}
                selected={failureMode === entry.mode}
                onPress={() => void setSyncFailureMode(entry.mode)}
                accessibilityHint={entry.hint}
              />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: spacing.md,
  },
  flex: {
    flex: 1,
  },
  card: {
    marginHorizontal: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.bg.card,
    overflow: 'hidden',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: 64,
  },
  statusText: {
    flex: 1,
    gap: 1,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border.subtle,
    marginLeft: spacing.lg + 20 + spacing.md,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  actionButton: {
    flex: 1,
  },
  devBlock: {
    marginHorizontal: spacing.lg,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border.subtle,
    gap: spacing.sm,
  },
  devHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  devNote: {
    lineHeight: 16,
  },
  modes: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
});
