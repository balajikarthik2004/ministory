import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import { colors, duration as motion, spacing } from '@minidrama/ui-tokens';
import { AppText } from '../../components/primitives/AppText';
import { Wordmark } from '../../components/catalogue/Wordmark';

/**
 * Splash — branding, then straight into the app.
 *
 * UI_UX_GUIDELINES.md §3 is specific: no spinner for the first 800ms, because
 * a spinner that flashes reads as slower than silence. So this screen shows
 * the mark, fades it up, and leaves. There is nothing to wait for in M2.1
 * (session resolution is M3), and inventing a delay to make the splash look
 * busy would make the app genuinely slower.
 *
 * The animation is opacity and transform on the native driver, so it runs on
 * the UI thread while JS is still warming up — which is exactly when a
 * JS-driven animation would stutter.
 */

/** Long enough for the mark to register, short enough not to be a toll gate. */
const HOLD_MS = 900;

export interface SplashScreenProps {
  onFinish: () => void;
}

export function SplashScreen({ onFinish }: SplashScreenProps): JSX.Element {
  const [opacity] = useState(() => new Animated.Value(0));
  const [lift] = useState(() => new Animated.Value(16));
  const [tagline] = useState(() => new Animated.Value(0));

  // `onFinish` in a ref: the timer must not restart because a parent
  // re-rendered and handed over a new closure.
  const onFinishRef = useRef(onFinish);
  useEffect(() => {
    onFinishRef.current = onFinish;
  }, [onFinish]);

  useEffect(() => {
    const notify = (): void => onFinishRef.current();

    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: motion.slow,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(lift, {
        toValue: 0,
        duration: motion.slow,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(tagline, {
        toValue: 1,
        duration: motion.base,
        delay: motion.base,
        useNativeDriver: true,
      }),
    ]).start();

    const timer = setTimeout(notify, HOLD_MS);
    return () => clearTimeout(timer);
  }, [lift, opacity, tagline]);

  return (
    <View style={styles.container}>
      <Animated.View style={{ opacity, transform: [{ translateY: lift }] }}>
        <Wordmark size="lg" />
      </Animated.View>

      <Animated.View style={[styles.tagline, { opacity: tagline }]}>
        <AppText variant="caption" tone="secondary">
          Short dramas. Big stories.
        </AppText>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg.primary,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
  },
  tagline: {
    alignItems: 'center',
  },
});
