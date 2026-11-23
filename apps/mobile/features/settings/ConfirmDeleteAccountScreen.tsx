import { useCallback, useState, type JSX } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { DELETION_CONFIRMATION } from '@minidrama/contracts';
import { colors, radius, spacing } from '@minidrama/ui-tokens';
import { AppText } from '../../components/primitives/AppText';
import { Button } from '../../components/primitives/Button';
import { FormField } from '../../components/primitives/FormField';
import { AuthScreenLayout } from '../auth/AuthScreenLayout';
import { FormBanner } from '../auth/FormBanner';
import { useSessionStore } from '../../store/session.store';
import {
  completeAccountDeletion,
  requestAccountDeletion,
  type DeletionOutcome,
} from '../../services/auth/deletion';

/**
 * Step two: prove it is you, then the point of no return.
 *
 * TWO WAYS TO CONFIRM, BECAUSE THERE ARE TWO KINDS OF ACCOUNT:
 *
 *   registered  the password. A real credential, verified server-side at the
 *               full Argon2 cost like any other.
 *   guest       the word DELETE, typed. A guest HAS no password (ADR-41) and
 *               the access token is the only credential that exists for them,
 *               so this is a speed bump and is not pretending otherwise —
 *               D2 accepted that trade rather than leave guests unable to
 *               delete at all.
 *
 * THE SCREEN NEVER DECIDES THAT A DELETION HAPPENED. It renders whatever
 * `requestAccountDeletion` concluded, and that function only ever reports
 * `deleted` when the server said so — either with a 200 or with a receipt
 * lookup. The `unconfirmed` branch below is the one that matters: it looks
 * like a failure to the viewer and leaves every byte on the device intact.
 */
export function ConfirmDeleteAccountScreen(): JSX.Element {
  const router = useRouter();
  const isGuest = useSessionStore((state) => state.status === 'guest');

  const [password, setPassword] = useState('');
  const [typed, setTyped] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [phase, setPhase] = useState<'form' | 'deleting' | 'done'>('form');

  const canSubmit = isGuest
    ? typed.trim().toUpperCase() === DELETION_CONFIRMATION
    : password.length > 0;

  const handleOutcome = useCallback(
    async (outcome: DeletionOutcome): Promise<void> => {
      switch (outcome.kind) {
        case 'deleted':
          /*
           * CONFIRMED BY THE SERVER. Only now is anything local destroyed,
           * and the screen is held on a terminal state while it happens so a
           * half-torn-down app is never interactive.
           */
          setPhase('done');
          await completeAccountDeletion();
          router.replace('/home');
          return;

        case 'reauth-failed':
          setPhase('form');
          setFieldError(outcome.message);
          return;

        case 'session-ended':
          setPhase('form');
          setBanner(outcome.message);
          return;

        case 'rate-limited':
        case 'unconfirmed':
        case 'failed':
          setPhase('form');
          setBanner(outcome.message);
          return;
      }
    },
    [router],
  );

  const handleSubmit = useCallback(() => {
    void (async () => {
      setFieldError(null);
      setBanner(null);
      setPhase('deleting');

      const outcome = await requestAccountDeletion(isGuest ? {} : { password });
      await handleOutcome(outcome);
    })();
  }, [handleOutcome, isGuest, password]);

  if (phase === 'deleting' || phase === 'done') {
    /*
     * NOT CANCELLABLE, AND NO BACK CONTROL. Deletion is in flight or the
     * teardown is running; leaving mid-way would strand the app with a
     * cleared cache and a live screen expecting data.
     */
    return (
      <AuthScreenLayout
        title={phase === 'done' ? 'Account deleted' : 'Deleting your account'}
        subtitle={
          phase === 'done'
            ? 'Clearing this device…'
            : 'This only takes a moment. Please keep the app open.'
        }
        showBack={false}
      >
        <View style={styles.centre}>
          <ActivityIndicator size="large" color={colors.accent.primary} />
        </View>
      </AuthScreenLayout>
    );
  }

  return (
    <AuthScreenLayout
      title="Confirm deletion"
      subtitle={
        isGuest
          ? 'Type DELETE to remove this device’s temporary account.'
          : 'Enter your password to confirm this is you.'
      }
    >
      <FormBanner message={banner} />

      {isGuest ? (
        <FormField
          label="Type DELETE"
          value={typed}
          onChangeText={setTyped}
          error={fieldError}
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder={DELETION_CONFIRMATION}
          accessibilityHint="Type the word DELETE in capitals to enable the button below"
        />
      ) : (
        <FormField
          label="Password"
          value={password}
          onChangeText={setPassword}
          error={fieldError}
          secure
          autoComplete="current-password"
          textContentType="password"
        />
      )}

      <View style={styles.finalWarning}>
        <Ionicons name="alert-circle" size={18} color={colors.status.error} />
        <AppText variant="caption" tone="secondary" style={styles.flex}>
          There is no undo and no recovery period.
        </AppText>
      </View>

      <Button
        label="Delete my account"
        variant="destructive"
        fullWidth
        disabled={!canSubmit}
        onPress={handleSubmit}
      />
      <Button label="Cancel" variant="secondary" fullWidth onPress={() => router.back()} />
    </AuthScreenLayout>
  );
}

const styles = StyleSheet.create({
  centre: {
    paddingVertical: spacing.xl * 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  finalWarning: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.bg.card,
  },
  flex: { flex: 1 },
});
