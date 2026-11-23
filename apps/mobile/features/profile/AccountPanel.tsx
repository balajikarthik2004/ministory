import { useCallback, useState, type JSX } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors, radius, spacing } from '@minidrama/ui-tokens';
import { AppText } from '../../components/primitives/AppText';
import { Button } from '../../components/primitives/Button';
import { SectionHeader } from '../../components/feedback/SectionHeader';
import { authApi, session } from '../../services/auth/session';
import { applyAccountChange } from '../../services/auth/account-change';
import { useSessionStore } from '../../store/session.store';

/**
 * The account block on the Profile screen: who you are, and the one action
 * that changes it.
 *
 * THREE STATES, AND EACH ONE EXISTS BECAUSE IT IS REACHABLE:
 *
 *   signed-out     The restore failed, or guest creation could not reach the
 *                  API. Browsing still works, so this is not an error screen
 *                  — it offers a sign-in and says nothing alarming.
 *   guest          The ordinary state for a new install. Offers the upgrade,
 *                  and says plainly what is at stake if they do not take it,
 *                  because "your history is only on this device" is
 *                  information a viewer can act on.
 *   authenticated  Shows the address, whether it is confirmed, and sign-out.
 */
export function AccountPanel(): JSX.Element {
  const router = useRouter();
  const status = useSessionStore((state) => state.status);
  const user = useSessionStore((state) => state.user);
  const emailVerified = useSessionStore((state) => state.emailVerified);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const handleSignOut = useCallback(() => {
    /*
     * Confirmed, because it is destructive in a way that is not obvious: a
     * guest who signs out and whose history had not yet synced loses the
     * thread of what they were watching. The copy says so rather than asking
     * "are you sure?", which gives the viewer nothing to be sure about.
     */
    Alert.alert(
      'Sign out?',
      'You can sign back in any time. Downloads and watch history stay on your account.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign out',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setBusy(true);
              try {
                await session.signOut();
                await applyAccountChange();
              } finally {
                setBusy(false);
              }
            })();
          },
        },
      ],
    );
  }, []);

  const handleResend = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    try {
      const accessToken = await session.getAccessToken();
      if (!accessToken) {
        setNotice('Sign in again to resend the confirmation.');
        return;
      }
      const result = await authApi.resendVerification(accessToken);
      setNotice(result.message);
    } catch {
      setNotice('We could not send that just now. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }, []);

  if (status === 'restoring') {
    return (
      <View style={styles.section}>
        <SectionHeader title="Account" />
        <View style={styles.card}>
          <AppText variant="body" tone="secondary">
            Checking your session…
          </AppText>
        </View>
      </View>
    );
  }

  if (status === 'signed-out') {
    return (
      <View style={styles.section}>
        <SectionHeader title="Account" subtitle="You're browsing without an account" />
        <View style={styles.card}>
          <AppText variant="body" tone="secondary">
            Sign in to sync your watch history and saved dramas across devices.
          </AppText>
          <Button label="Sign in" onPress={() => router.push('/login')} fullWidth />
          <Button
            label="Create an account"
            onPress={() => router.push('/register')}
            variant="secondary"
            fullWidth
          />
        </View>
      </View>
    );
  }

  if (status === 'guest') {
    return (
      <View style={styles.section}>
        <SectionHeader title="Account" subtitle="Watching as a guest" />
        <View style={styles.card}>
          <View style={styles.notice}>
            <Ionicons name="information-circle" size={18} color={colors.accent.primary} />
            <AppText variant="caption" tone="secondary" style={styles.flex}>
              Your watch history is saved to this device and a temporary account. Create an account
              to keep it if you change phones.
            </AppText>
          </View>
          <Button label="Create an account" onPress={() => router.push('/register')} fullWidth />
          <Button
            label="I already have an account"
            onPress={() => router.push('/login')}
            variant="secondary"
            fullWidth
          />
        </View>
      </View>
    );
  }

  // authenticated
  return (
    <View style={styles.section}>
      <SectionHeader title="Account" />
      <View style={styles.card}>
        <View style={styles.row}>
          <Ionicons name="mail-outline" size={18} color={colors.text.secondary} />
          <AppText variant="body" style={styles.flex} numberOfLines={1}>
            {user?.email ?? 'No email on this account'}
          </AppText>
          <Ionicons
            name={emailVerified ? 'checkmark-circle' : 'alert-circle-outline'}
            size={18}
            color={emailVerified ? colors.status.success : colors.status.warning}
          />
        </View>

        {/*
         * SHOWN, BUT NOT BLOCKING. An unconfirmed address does not stop
         * anyone watching — gating playback on a mailbox round trip fails the
         * viewer for our convenience. What it gates is password recovery, so
         * the copy says exactly that rather than nagging without a reason.
         */}
        {emailVerified ? null : (
          <View style={styles.notice}>
            <Ionicons name="alert-circle-outline" size={18} color={colors.status.warning} />
            <View style={styles.flex}>
              <AppText variant="caption" tone="secondary">
                Confirm your email address so you can reset your password if you forget it.
              </AppText>
              <Button
                label="Resend confirmation"
                onPress={() => void handleResend()}
                variant="ghost"
                size="sm"
                loading={busy}
              />
            </View>
          </View>
        )}

        {notice ? (
          <AppText variant="caption" tone="secondary">
            {notice}
          </AppText>
        ) : null}

        <Button
          label="Sign out"
          onPress={handleSignOut}
          variant="secondary"
          loading={busy}
          fullWidth
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  card: {
    backgroundColor: colors.bg.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  flex: { flex: 1 },
});
