import type { JSX } from 'react';
import { StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { EpisodeSummary, UnlockOption } from '@minidrama/contracts';
import { colors, radius, spacing } from '@minidrama/ui-tokens';
import { absoluteFill, screen } from '../../constants/layout';
import { AppText } from '../../components/primitives/AppText';
import { Button } from '../../components/primitives/Button';
import { Gradient } from '../../components/primitives/Gradient';
import { Artwork } from '../../components/catalogue/Artwork';

/**
 * Shown when the backend refuses a playback ticket with `EPISODE_LOCKED`.
 *
 * UI_UX_GUIDELINES.md §3: a locked episode swiped into shows the unlock offer
 * over a still, not a black screen — "the user should see what they are being
 * offered". So the episode's own thumbnail sits behind the panel.
 *
 * None of these actions does anything yet. Monetisation is M7, and CLAUDE.md
 * §16.14 forbids claiming a feature works before it does, so each one reports
 * honestly that it is not available rather than failing silently or opening a
 * dead sheet.
 */

const OPTION_COPY: Record<UnlockOption, { label: string; icon: string; detail: string }> = {
  SUBSCRIPTION: {
    label: 'Subscribe',
    icon: 'star',
    detail: 'Every episode, no waiting',
  },
  COIN: {
    label: 'Use coins',
    icon: 'diamond',
    detail: 'Unlock this episode only',
  },
  REWARDED_AD: {
    label: 'Watch an ad',
    icon: 'play-circle',
    detail: 'Free, takes about 30 seconds',
  },
};

export interface LockedEpisodePanelProps {
  episode: EpisodeSummary;
  insetTop: number;
  insetBottom: number;
  onClose: () => void;
  onUnavailable: (option: UnlockOption) => void;
}

export function LockedEpisodePanel({
  episode,
  insetTop,
  insetBottom,
  onClose,
  onUnavailable,
}: LockedEpisodePanelProps): JSX.Element {
  const options =
    episode.unlockOptions.length > 0 ? episode.unlockOptions : (['SUBSCRIPTION'] as const);

  return (
    <View style={styles.container}>
      {/* Explicit dimensions, not inset-based stretching. An `Image` sized
          only by absolute insets resolved to its own intrinsic ratio here and
          covered just over half the screen width, leaving a hard vertical
          edge down the middle of the still. */}
      <Artwork
        url={episode.thumbnailUrl}
        style={styles.backdrop}
        accessibilityLabel={`Episode ${episode.episodeNumber} still`}
      />
      {/* Heavier than a normal scrim: this is a still behind a dialogue, and
          the offer has to be the thing that reads. */}
      <View style={styles.dim} />
      <Gradient direction="down" intensity={0.96} steps={8} style={styles.scrim} />

      <View
        style={[
          styles.sheet,
          { paddingTop: insetTop + spacing.xl, paddingBottom: insetBottom + spacing.xl },
        ]}
      >
        <View style={styles.lockRing}>
          <Ionicons name="lock-closed" size={26} color={colors.accent.primary} />
        </View>

        <AppText variant="h1" style={styles.centred}>
          {`Unlock Episode ${episode.episodeNumber}`}
        </AppText>
        <AppText variant="body" tone="secondary" style={styles.centred}>
          {`Subscribe, use ${episode.coinPrice} coins, or watch an ad to keep going.`}
        </AppText>

        <View style={styles.options}>
          {options.map((option) => {
            const copy = OPTION_COPY[option];
            return (
              <View key={option} style={styles.optionRow}>
                <Button
                  label={copy.label}
                  icon={copy.icon as never}
                  variant={option === 'SUBSCRIPTION' ? 'primary' : 'secondary'}
                  size="md"
                  fullWidth
                  onPress={() => onUnavailable(option)}
                  accessibilityHint={copy.detail}
                />
                <AppText variant="micro" tone="tertiary" style={styles.centred}>
                  {copy.detail}
                </AppText>
              </View>
            );
          })}
        </View>

        {/* Explicitly stated rather than implied. A subscribe button that does
            nothing is worse than one that says why. */}
        <AppText variant="micro" tone="tertiary" style={styles.centred}>
          Payments arrive in a later milestone — these are not live yet.
        </AppText>

        <Button label="Back to episodes" variant="ghost" size="md" onPress={onClose} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...absoluteFill,
    backgroundColor: colors.bg.primary,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: screen.width,
    height: screen.height,
  },
  dim: {
    ...absoluteFill,
    backgroundColor: colors.overlay.scrim,
  },
  scrim: {
    top: undefined,
    height: '70%',
  },
  sheet: {
    ...absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
  },
  lockRing: {
    width: 64,
    height: 64,
    borderRadius: radius.full,
    backgroundColor: colors.accent.subtle,
    borderWidth: 1,
    borderColor: colors.accent.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centred: {
    textAlign: 'center',
  },
  options: {
    alignSelf: 'stretch',
    gap: spacing.md,
    marginTop: spacing.md,
  },
  optionRow: {
    gap: spacing.xs,
  },
});
