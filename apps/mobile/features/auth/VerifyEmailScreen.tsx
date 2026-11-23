import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation } from '@tanstack/react-query';
import { colors, spacing } from '@minidrama/ui-tokens';
import { AppText } from '../../components/primitives/AppText';
import { Button } from '../../components/primitives/Button';
import { FormField } from '../../components/primitives/FormField';
import { AuthScreenLayout } from './AuthScreenLayout';
import { FormBanner } from './FormBanner';
import { authApi, session } from '../../services/auth/session';
import { toAppError } from '../../services/errors';

/**
 * Confirm an email address from the link in the welcome email.
 *
 * SUBMITS AUTOMATICALLY WHEN THE DEEP LINK CARRIES A TOKEN. Someone who taps
 * a link called "confirm your email address" has already expressed the
 * intent; presenting them with a filled-in field and a button to press is
 * asking the same question twice.
 *
 * WHY A MUTATION AND NOT AN EFFECT. The obvious shape — `useEffect` that
 * fires the request — calls setState from inside an effect, which React's
 * lint rules reject and which produces a cascading render. More to the point
 * it would need a ref to avoid firing twice, because Expo Router re-renders a
 * screen with the same params on a navigation-state restore or a fast refresh,
 * and a second attempt would consume nothing and report the first success as
 * "that link is no longer valid" — technically true, completely misleading.
 *
 * TanStack Query already owns server state here. `mutate` is safe to call
 * during render-adjacent work, `isPending` drives the spinner, and the
 * `hasFired` guard below is one boolean rather than a ref plus an effect.
 */
export function VerifyEmailScreen(): JSX.Element {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();

  const [token, setToken] = useState(params.token ?? '');
  const autoSubmitted = useRef(false);

  const verification = useMutation({
    mutationFn: async (value: string) => {
      await authApi.verifyEmail(value.trim());
      // The profile now reports a verified address; pull it so Profile stops
      // showing the "confirm your email" prompt.
      await session.reload();
    },
    // A failed confirmation is a dead token, not a flaky network. Retrying
    // cannot succeed and would only delay the message the viewer needs.
    retry: false,
  });

  const { mutate } = verification;

  const submit = useCallback(
    (value: string) => {
      if (value.trim().length === 0) return;
      mutate(value);
    },
    [mutate],
  );

  /*
   * The auto-submit.
   *
   * Firing a network request from an effect is the sanctioned shape — an
   * effect is for synchronising with an external system, and this is one.
   * What made the earlier version wrong was calling `setState` synchronously
   * in the effect body to drive a spinner; `mutate` schedules the request and
   * TanStack Query owns the pending state, so nothing cascades.
   *
   * The ref makes it fire ONCE. Expo Router re-renders a screen with the same
   * params on a navigation-state restore or a fast refresh, and a second
   * attempt would consume nothing and report the first success as "that link
   * is no longer valid" — technically true, completely misleading.
   */
  useEffect(() => {
    if (autoSubmitted.current || !params.token) return;
    autoSubmitted.current = true;
    mutate(params.token);
  }, [params.token, mutate]);

  const awaitingAutoSubmit = Boolean(params.token) && verification.isIdle;

  if (verification.isPending || awaitingAutoSubmit) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg.primary,
          alignItems: 'center',
          justifyContent: 'center',
          gap: spacing.md,
        }}
      >
        <ActivityIndicator color={colors.accent.primary} />
        <AppText variant="body" tone="secondary">
          Confirming your email…
        </AppText>
      </View>
    );
  }

  if (verification.isSuccess) {
    return (
      <AuthScreenLayout
        title="Email confirmed"
        subtitle="Thanks — you can now recover your account if you ever forget your password."
        showBack={false}
      >
        <Button
          label="Continue watching"
          onPress={() => router.replace('/home')}
          fullWidth
          size="lg"
        />
      </AuthScreenLayout>
    );
  }

  return (
    <AuthScreenLayout
      title="Confirm your email"
      subtitle="Paste the code from your welcome email if it wasn't filled in automatically."
    >
      <FormBanner
        message={verification.isError ? toAppError(verification.error).message : null}
        tone="error"
      />

      <FormField
        label="Confirmation code"
        value={token}
        onChangeText={setToken}
        placeholder="From your welcome email"
        autoCapitalize="none"
        autoCorrect={false}
      />

      <Button
        label="Confirm"
        onPress={() => submit(token)}
        disabled={token.trim().length === 0}
        fullWidth
        size="lg"
      />
      <Button label="Not now" onPress={() => router.replace('/home')} variant="ghost" fullWidth />
    </AuthScreenLayout>
  );
}
