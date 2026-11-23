import type { JSX } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '@minidrama/ui-tokens';
import { Gradient } from './Gradient';

/**
 * A scrim behind the status bar, for screens whose content scrolls underneath
 * it.
 *
 * Edge-to-edge is the right look for a cinematic app — the home banner and the
 * drama hero both draw under the status bar on purpose (UI_UX_GUIDELINES.md
 * §2). The cost is that once the screen scrolls, ordinary content arrives
 * there too. On a device that showed as the "Episodes · Season 1" heading
 * sitting directly on top of the clock.
 *
 * A solid bar would fix it and ruin the hero. This fades from the background
 * colour at the very top to transparent by the bottom of the inset, so it
 * reads as part of the artwork while the hero is in view and as separation
 * once anything else scrolls up to meet it.
 */
export function TopScrim(): JSX.Element | null {
  const insets = useSafeAreaInsets();
  if (insets.top <= 0) return null;

  return (
    <View style={[styles.container, { height: insets.top + SCRIM_FADE }]} pointerEvents="none">
      {/* The inset itself is near-solid. A pure gradient across this strip
          was not enough: the ramp put only ~40% opacity where the clock sits,
          and the "Episodes" heading scrolling underneath stayed legible
          through it. The status bar has to win outright. */}
      <View style={[styles.bar, { height: insets.top }]} />
      {/* Then a short fade, so the bottom of the bar is not a hard line
          across the hero artwork. */}
      <View style={styles.fade}>
        <Gradient direction="up" intensity={SCRIM_OPACITY} steps={5} color={colors.bg.primary} />
      </View>
    </View>
  );
}

/** How far past the inset the fade continues, so the edge is not a hard line. */
const SCRIM_FADE = 16;
const SCRIM_OPACITY = 0.92;

const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.bg.primary,
    opacity: SCRIM_OPACITY,
  },
  fade: {
    height: SCRIM_FADE,
  },
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    // Above the scrolling content, below nothing else: the screens that use
    // this draw their own controls after it.
    zIndex: 20,
  },
});
