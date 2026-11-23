import type { JSX } from 'react';
import { StyleSheet, View } from 'react-native';
import { Tabs } from 'expo-router/js-tabs';
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, radius, spacing } from '@minidrama/ui-tokens';
import { TAB_BAR_HEIGHT, hitSlopFor } from '../../constants/layout';
import { AppText } from '../../components/primitives/AppText';
import { PressableScale } from '../../components/primitives/PressableScale';

/**
 * Bottom navigation: Home · Search · My List · Profile.
 *
 * A custom bar rather than the default one. The default renders a light
 * system surface with its own typography, which fights the dark palette, and
 * the tokens are supposed to be the only source of colour and type
 * (UI_UX_GUIDELINES.md §1). The bar is 56dp plus the safe-area inset, per §2.
 *
 * `expo-router/js-tabs` is used rather than the deprecated root `Tabs` export.
 * It carries expo-router's own fork of the bottom-tab navigator, so no
 * additional navigation dependency is involved.
 */

const TABS: ReadonlyArray<{
  name: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  iconActive: keyof typeof Ionicons.glyphMap;
}> = [
  { name: 'home', label: 'Home', icon: 'home-outline', iconActive: 'home' },
  { name: 'search', label: 'Search', icon: 'search-outline', iconActive: 'search' },
  { name: 'my-list', label: 'My List', icon: 'heart-outline', iconActive: 'heart' },
  { name: 'profile', label: 'Profile', icon: 'person-outline', iconActive: 'person' },
];

function MiniDramaTabBar({ state, navigateToTab }: BottomTabBarProps): JSX.Element {
  // The navigator supplies `insets`, but it is the *bar's* inset budget rather
  // than the device's, and it is zero until the first layout pass. Reading the
  // provider directly keeps the bar correctly inset on the first frame.
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[styles.bar, { paddingBottom: insets.bottom, height: TAB_BAR_HEIGHT + insets.bottom }]}
    >
      {state.routes.map((route, index) => {
        const config = TABS.find((tab) => tab.name === route.name);
        if (!config) return null;

        const isFocused = state.index === index;

        const onPress = (): void => {
          // Tapping the already-active tab is a no-op rather than a
          // re-navigation, which would reset the screen's scroll position.
          if (!isFocused) navigateToTab(route.key);
        };

        return (
          <PressableScale
            key={route.key}
            onPress={onPress}
            activeScale={0.9}
            hitSlop={hitSlopFor(TAB_BAR_HEIGHT)}
            accessibilityRole="button"
            accessibilityState={{ selected: isFocused }}
            accessibilityLabel={config.label}
            style={styles.tab}
          >
            <View style={[styles.iconWrap, isFocused ? styles.iconWrapActive : null]}>
              <Ionicons
                name={isFocused ? config.iconActive : config.icon}
                size={22}
                color={isFocused ? colors.accent.primary : colors.text.tertiary}
              />
            </View>
            <AppText variant="micro" tone={isFocused ? 'accent' : 'tertiary'}>
              {config.label}
            </AppText>
          </PressableScale>
        );
      })}
    </View>
  );
}

export default function TabsLayout(): JSX.Element {
  return (
    <Tabs
      tabBar={(props: BottomTabBarProps) => <MiniDramaTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: colors.bg.primary },
      }}
    >
      <Tabs.Screen name="home" options={{ title: 'Home' }} />
      <Tabs.Screen name="search" options={{ title: 'Search' }} />
      <Tabs.Screen name="my-list" options={{ title: 'My List' }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.bg.secondary,
    // A hairline rather than a shadow: elevation on #090A0F comes from
    // background lightness, and a shadow here is invisible and costs render
    // time (UI_UX_GUIDELINES.md §1).
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border.subtle,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingTop: spacing.sm,
  },
  iconWrap: {
    paddingHorizontal: spacing.md,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  iconWrapActive: {
    backgroundColor: colors.accent.subtle,
  },
});
