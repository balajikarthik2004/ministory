import type { JSX, ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors, spacing } from '@minidrama/ui-tokens';
import { AppText } from '../../components/primitives/AppText';
import { PressableScale } from '../../components/primitives/PressableScale';
import { Wordmark } from '../../components/catalogue/Wordmark';
import { hitSlopFor } from '../../constants/layout';

/**
 * The frame every authentication screen sits in.
 *
 * ONE COMPONENT RATHER THAN FOUR COPIES, because the thing it gets right is
 * easy to get wrong individually: KEYBOARD AVOIDANCE. A password field near
 * the bottom of a 5-inch screen disappears behind the keyboard, and the
 * submit button with it, so the form looks broken on exactly the low-end
 * devices the launch audience carries (CLAUDE.md §2).
 *
 * `KeyboardAvoidingView` plus a scroll view with
 * `keyboardShouldPersistTaps="handled"` is the combination that works on both
 * platforms: `padding` behaviour on iOS, `height` on Android, and the
 * persist-taps setting so the first tap on the submit button submits instead
 * of being eaten dismissing the keyboard.
 */

export interface AuthScreenLayoutProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** Pinned under the form, outside the scroll area's padding. */
  footer?: ReactNode;
  /** Hides the back control on screens that are a session's entry point. */
  showBack?: boolean;
}

export function AuthScreenLayout({
  title,
  subtitle,
  children,
  footer,
  showBack = true,
}: AuthScreenLayoutProps): JSX.Element {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing['2xl'] },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          {showBack && router.canGoBack() ? (
            <PressableScale
              onPress={() => router.back()}
              hitSlop={hitSlopFor(24)}
              accessibilityRole="button"
              accessibilityLabel="Go back"
              style={styles.back}
            >
              <Ionicons name="chevron-back" size={24} color={colors.text.primary} />
            </PressableScale>
          ) : (
            <View style={styles.back} />
          )}
          <Wordmark size="sm" />
          <View style={styles.back} />
        </View>

        <View style={styles.titleBlock}>
          <AppText variant="h1">{title}</AppText>
          {subtitle ? (
            <AppText variant="body" tone="secondary">
              {subtitle}
            </AppText>
          ) : null}
        </View>

        <View style={styles.form}>{children}</View>

        {footer ? <View style={styles.footer}>{footer}</View> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg.primary },
  content: { paddingHorizontal: spacing.lg, gap: spacing.xl, flexGrow: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  back: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  titleBlock: { gap: spacing.xs },
  form: { gap: spacing.md },
  footer: { marginTop: 'auto', paddingTop: spacing.xl, gap: spacing.md },
});
