import type { JSX } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors, radius, spacing } from '@minidrama/ui-tokens';
import { AppText } from '../../components/primitives/AppText';
import { Button } from '../../components/primitives/Button';
import { AuthScreenLayout } from '../auth/AuthScreenLayout';
import { useSessionStore } from '../../store/session.store';

/**
 * Step one of deletion: what it does, before anything is asked of you.
 *
 * SEPARATE FROM THE CONFIRMATION SCREEN ON PURPOSE. Putting the consequences
 * and the password field on one screen means the consequences are read, at
 * best, while typing. Splitting them costs one tap and makes the irreversible
 * part a decision rather than a reflex.
 *
 * The copy says what is removed rather than asking "are you sure?" — a
 * question that gives the viewer nothing to be sure about. It is the same
 * rule the sign-out dialog in `AccountPanel` follows.
 */
export function DeleteAccountScreen(): JSX.Element {
  const router = useRouter();
  const isGuest = useSessionStore((state) => state.status === 'guest');

  return (
    <AuthScreenLayout
      title="Delete your account"
      subtitle={
        isGuest
          ? 'This removes the temporary account this device has been watching with.'
          : 'This removes your account and everything on it.'
      }
    >
      <View style={styles.card}>
        <AppText variant="bodyStrong">What is deleted</AppText>
        <Bullet icon="person-outline" text="Your account and how you sign in" />
        <Bullet icon="time-outline" text="Everything you have watched, and where you stopped" />
        <Bullet icon="heart-outline" text="Your saved dramas" />
        <Bullet icon="phone-portrait-outline" text="Every device you are signed in on" />
      </View>

      <View style={styles.card}>
        <AppText variant="bodyStrong">What is kept</AppText>
        {/*
          Said plainly, and only about what the system actually does. No
          statute, policy or legal retention period appears anywhere in this
          flow or on the public page (M2.6 R4) — those need a lawyer, not a
          developer writing UI copy.
        */}
        <Bullet
          icon="stats-chart-outline"
          text="Anonymous viewing statistics, with your account unlinked from them. They are deleted within 90 days."
        />
      </View>

      <View style={styles.warning}>
        <Ionicons name="warning-outline" size={20} color={colors.status.error} />
        <AppText variant="caption" tone="secondary" style={styles.flex}>
          This happens immediately and cannot be undone. You can sign up again with the same email
          address, but nothing will carry over.
        </AppText>
      </View>

      <Button
        label="Continue"
        variant="destructive"
        fullWidth
        onPress={() => router.push('/delete-account/confirm')}
      />
      <Button label="Keep my account" variant="secondary" fullWidth onPress={() => router.back()} />
    </AuthScreenLayout>
  );
}

function Bullet({
  icon,
  text,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  text: string;
}): JSX.Element {
  return (
    <View style={styles.bullet}>
      <Ionicons name={icon} size={18} color={colors.text.secondary} />
      <AppText variant="caption" tone="secondary" style={styles.flex}>
        {text}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bg.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  bullet: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  warning: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.status.error,
  },
  flex: { flex: 1 },
});
