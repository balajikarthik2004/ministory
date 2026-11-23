import type { JSX } from 'react';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Switch, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, spacing, MIN_TOUCH_TARGET } from '@minidrama/ui-tokens';
import { TAB_BAR_HEIGHT } from '../../constants/layout';
import { ErrorState } from '../../components/feedback/ErrorState';
import { SectionHeader } from '../../components/feedback/SectionHeader';
import { AppText } from '../../components/primitives/AppText';
import { Badge } from '../../components/primitives/Badge';
import { Button } from '../../components/primitives/Button';
import { Chip } from '../../components/primitives/Chip';
import { PressableScale } from '../../components/primitives/PressableScale';
import { Skeleton } from '../../components/primitives/Skeleton';
import { TopScrim } from '../../components/primitives/TopScrim';
import { MOCK_LANGUAGES } from '../../data/catalogue.mock';
import { useFavorites, useHistory, useProfile } from '../../services/catalogue.queries';
// The mock catalogue's failure switch. Only meaningful in mock mode — in
// live mode the catalogue comes from the server, so the toggle is hidden
// rather than sitting on screen doing nothing.
import { getMockFailureMode, setMockFailureMode } from '../../services/mock-api';
import { isLiveMode } from '../../services/api';
import { toAppError } from '../../services/errors';
import { usePreferencesStore } from '../../store/preferences.store';
import { SyncPanel } from './SyncPanel';
import { AccountPanel } from './AccountPanel';

/**
 * Profile — identity, preferences and settings.
 *
 * Section order follows UI_UX_GUIDELINES.md §3: identity header, then history
 * and favourites counts, subscription, language, notifications, settings, and
 * account deletion placed last and styled with `status.error`.
 *
 * M2.5 replaced the mock profile with the real session. `AccountPanel` owns
 * everything about who is signed in — sign in, sign out, guest upgrade and
 * email confirmation — so this screen stays about preferences and activity.
 */

export function ProfileScreen(): JSX.Element {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const profileQuery = useProfile();
  const favoritesQuery = useFavorites();
  const historyQuery = useHistory();

  const preferredLanguageId = usePreferencesStore((state) => state.preferredLanguageId);
  const setPreferredLanguage = usePreferencesStore((state) => state.setPreferredLanguage);
  const autoplayNext = usePreferencesStore((state) => state.autoplayNext);
  const setAutoplayNext = usePreferencesStore((state) => state.setAutoplayNext);
  const muted = usePreferencesStore((state) => state.muted);
  const setMuted = usePreferencesStore((state) => state.setMuted);

  const [failureMode, setFailureModeState] = useState(getMockFailureMode());

  const toggleFailureMode = useCallback((enabled: boolean) => {
    setMockFailureMode(enabled);
    setFailureModeState(enabled);
  }, []);

  if (profileQuery.isPending) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top + spacing.lg }]}>
        <View style={styles.skeletonArea}>
          <Skeleton width={72} height={72} borderRadius={999} />
          <Skeleton width={'50%'} height={24} />
          <Skeleton width={'70%'} height={14} />
          <Skeleton width={'100%'} height={90} borderRadius={12} />
          <Skeleton width={'100%'} height={140} borderRadius={12} />
        </View>
      </View>
    );
  }

  if (profileQuery.isError || !profileQuery.data) {
    return (
      <View style={[styles.screen, styles.centred]}>
        <ErrorState
          message={toAppError(profileQuery.error).message}
          onRetry={() => void profileQuery.refetch()}
          retrying={profileQuery.isFetching}
        />
      </View>
    );
  }

  const profile = profileQuery.data;
  /*
   * What to call someone who has not given a name.
   *
   * "Guest" IS NOT A SAFE FALLBACK ANY MORE. Before M2.5 every profile was
   * the mock guest, so it read correctly. Now `isAnonymous` is a real
   * distinction, and a registered account that simply never filled in the
   * optional Name field was being labelled "Guest" while its own email
   * address sat on the line underneath — caught on a device during M2.5
   * verification.
   *
   * The email's local part is a better name than a wrong one, and "Guest" is
   * reserved for accounts that actually are guests.
   */
  const accountName =
    profile.displayName ??
    (profile.isAnonymous ? 'Guest' : (profile.email?.split('@')[0] ?? 'Your account'));
  const initial = accountName.trim().charAt(0).toUpperCase() || 'G';

  return (
    <View style={styles.screen}>
      <TopScrim />
      <ScrollView
        style={styles.screen}
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + spacing.lg,
            paddingBottom: insets.bottom + TAB_BAR_HEIGHT + spacing.xl,
          },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Identity ─────────────────────────────────────────────── */}
        <View style={styles.identity}>
          <View style={styles.avatar}>
            <AppText variant="h1" tone="onAccent">
              {initial}
            </AppText>
          </View>
          <View style={styles.identityText}>
            <AppText variant="h1" numberOfLines={1}>
              {accountName}
            </AppText>
            <AppText variant="caption" tone="secondary" numberOfLines={1}>
              {profile.email ?? profile.phone ?? 'Browsing as a guest'}
            </AppText>
            <View style={styles.identityBadges}>
              <Badge
                label={profile.subscriptionStatus === 'ACTIVE' ? 'Premium' : 'Free plan'}
                tone={profile.subscriptionStatus === 'ACTIVE' ? 'accent' : 'neutral'}
              />
              {profile.preferredLanguage ? (
                <Badge label={profile.preferredLanguage.nativeName} tone="live" />
              ) : null}
            </View>
          </View>
        </View>

        {/* Honest about what is and is not real. CLAUDE.md §16.12.
            Authentication is live as of M2.5; monetisation is not. */}
        <View style={styles.devNotice}>
          <Ionicons name="construct-outline" size={14} color={colors.status.warning} />
          <AppText variant="micro" tone="secondary" style={styles.flex}>
            Subscriptions and payments arrive in a later milestone. The plan badge above is a
            placeholder.
          </AppText>
        </View>

        {/* ── Activity ─────────────────────────────────────────────────── */}
        <View style={styles.statRow}>
          <StatTile
            label="Saved"
            value={favoritesQuery.data?.length ?? 0}
            icon="heart"
            onPress={() => router.push('/my-list')}
          />
          <StatTile
            label="Watched"
            value={historyQuery.data?.length ?? 0}
            icon="time"
            onPress={() => router.push('/my-list')}
          />
          <StatTile
            label="Genres"
            value={profile.preferredGenres.length}
            icon="pricetags"
            onPress={() => router.push('/search')}
          />
        </View>

        {/* ── Language ─────────────────────────────────────────────────── */}
        <View style={styles.section}>
          <SectionHeader
            title="Content language"
            subtitle="Which language the catalogue shows first"
          />
          <View style={styles.chipGrid}>
            {MOCK_LANGUAGES.map((language) => (
              <Chip
                key={language.id}
                label={`${language.name} · ${language.nativeName}`}
                selected={preferredLanguageId === language.id}
                onPress={() => setPreferredLanguage(language.id)}
              />
            ))}
          </View>
          {/* The interface language is a separate decision from the content
            language, and only English ships in M2.1. Saying so is better than
            a picker that silently does nothing. */}
          <AppText variant="micro" tone="tertiary" style={styles.sectionNote}>
            The interface is English for now. Tamil, Telugu and Hindi interface translations arrive
            with localisation.
          </AppText>
        </View>

        {/* ── Playback settings ────────────────────────────────────────── */}
        <View style={styles.section}>
          <SectionHeader title="Playback" />
          <View style={styles.card}>
            <SettingRow
              icon="play-forward"
              label="Autoplay next episode"
              hint="Moves to the next episode when one finishes"
              value={autoplayNext}
              onValueChange={setAutoplayNext}
            />
            <View style={styles.divider} />
            <SettingRow
              icon="volume-mute"
              label="Start muted"
              hint="Episodes begin without sound until you unmute"
              value={muted}
              onValueChange={setMuted}
            />
          </View>
        </View>

        {/* ── Playback sync (M2.2) ─────────────────────────────────────── */}
        <SyncPanel />

        {/* ── Developer tools ──────────────────────────────────────────── */}
        {__DEV__ && !isLiveMode ? (
          <View style={styles.section}>
            <SectionHeader title="Developer" subtitle="Mock mode only" />
            <View style={styles.card}>
              <SettingRow
                icon="bug"
                label="Simulate network failure"
                hint="Makes every data request fail, to exercise error and retry states"
                value={failureMode}
                onValueChange={toggleFailureMode}
              />
            </View>
          </View>
        ) : null}

        {/* ── Account (M2.5) ───────────────────────────────────────────── */}
        <AccountPanel />

        {/* ── Not yet built ────────────────────────────────────────────── */}
        <View style={styles.section}>
          <SectionHeader title="More" />
          <View style={styles.card}>
            <LinkRow
              icon="notifications-outline"
              label="Notifications"
              detail="Not yet available"
            />
            <View style={styles.divider} />
            <LinkRow icon="shield-checkmark-outline" label="Privacy" detail="Not yet available" />
            <View style={styles.divider} />
            <LinkRow icon="help-circle-outline" label="Help & support" detail="Not yet available" />
          </View>
        </View>

        {/* Destructive action last, as the guidelines require.
            M2.6 made it real: it opens the two-step flow in (settings), which
            explains what goes before asking for anything. */}
        <View style={styles.dangerZone}>
          <Button
            label="Delete account"
            variant="destructive"
            size="md"
            fullWidth
            onPress={() => router.push('/delete-account')}
            accessibilityHint="Opens account deletion, which explains what is removed before confirming"
          />
          <AppText variant="micro" tone="tertiary" style={styles.centredText}>
            Deletion is immediate and cannot be undone.
          </AppText>
        </View>
      </ScrollView>
    </View>
  );
}

function StatTile({
  label,
  value,
  icon,
  onPress,
}: {
  label: string;
  value: number;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
}): JSX.Element {
  return (
    <PressableScale
      onPress={onPress}
      activeScale={0.96}
      accessibilityRole="button"
      accessibilityLabel={`${value} ${label}`}
      style={styles.statTile}
    >
      <Ionicons name={icon} size={18} color={colors.accent.primary} />
      <AppText variant="h2">{String(value)}</AppText>
      <AppText variant="micro" tone="secondary">
        {label}
      </AppText>
    </PressableScale>
  );
}

function SettingRow({
  icon,
  label,
  hint,
  value,
  onValueChange,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}): JSX.Element {
  return (
    <View style={styles.settingRow}>
      <Ionicons name={icon} size={20} color={colors.text.secondary} />
      <View style={styles.flex}>
        <AppText variant="bodyStrong">{label}</AppText>
        <AppText variant="micro" tone="tertiary">
          {hint}
        </AppText>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        accessibilityLabel={label}
        trackColor={{ false: colors.bg.elevated, true: colors.accent.subtle }}
        thumbColor={value ? colors.accent.primary : colors.text.tertiary}
      />
    </View>
  );
}

function LinkRow({
  icon,
  label,
  detail,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  detail: string;
}): JSX.Element {
  return (
    <View style={styles.settingRow} accessible accessibilityLabel={`${label}. ${detail}`}>
      <Ionicons name={icon} size={20} color={colors.text.secondary} />
      <View style={styles.flex}>
        <AppText variant="bodyStrong" tone="secondary">
          {label}
        </AppText>
      </View>
      <AppText variant="micro" tone="tertiary">
        {detail}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.bg.primary,
  },
  content: {
    gap: spacing.xl,
  },
  centred: {
    justifyContent: 'center',
  },
  centredText: {
    textAlign: 'center',
  },
  skeletonArea: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  flex: {
    flex: 1,
  },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingHorizontal: spacing.lg,
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: radius.full,
    backgroundColor: colors.accent.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  identityText: {
    flex: 1,
    gap: spacing.xs,
  },
  identityBadges: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  devNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.bg.card,
    borderWidth: 1,
    borderColor: colors.border.subtle,
  },
  statRow: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    // Without this the row sizes to its content and the `flex: 1` tiles
    // inside it collapse: a row child of a column container does not stretch
    // on its own, so the three tiles ended up crammed into the left third of
    // the screen.
    alignSelf: 'stretch',
  },
  statTile: {
    flex: 1,
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.bg.card,
    minHeight: MIN_TOUCH_TARGET * 2,
    justifyContent: 'center',
  },
  section: {
    gap: spacing.md,
  },
  sectionNote: {
    paddingHorizontal: spacing.lg,
  },
  chipGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  card: {
    marginHorizontal: spacing.lg,
    borderRadius: radius.md,
    backgroundColor: colors.bg.card,
    overflow: 'hidden',
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: 64,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border.subtle,
    marginLeft: spacing.lg + 20 + spacing.md,
  },
  dangerZone: {
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
  },
});
