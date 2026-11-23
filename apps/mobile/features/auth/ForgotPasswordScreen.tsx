import { useCallback, useState, type JSX } from 'react';
import { useRouter } from 'expo-router';
import { Button } from '../../components/primitives/Button';
import { FormField } from '../../components/primitives/FormField';
import { AppText } from '../../components/primitives/AppText';
import { AuthScreenLayout } from './AuthScreenLayout';
import { FormBanner } from './FormBanner';
import { authApi } from '../../services/auth/session';
import { toAppError } from '../../services/errors';

/**
 * Request a password-reset link.
 *
 * THE SCREEN SAYS THE SAME THING WHATEVER HAPPENS, because the server does.
 * `POST /auth/forgot-password` returns the identical acknowledgement for a
 * registered address and an unknown one — anything else would let someone
 * test an address list against this form. The copy is therefore written to be
 * true in both cases: it promises that *if* there is an account, something
 * has been sent.
 *
 * It would be friendlier to say "we've emailed you". It would also be a lie
 * half the time, and an account-existence oracle the other half.
 */
export function ForgotPasswordScreen(): JSX.Element {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (email.trim().length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      await authApi.forgotPassword(email.trim());
      setSent(true);
    } catch (cause) {
      // Only a transport or rate-limit failure can reach here; the endpoint
      // does not fail for an unknown address.
      setError(toAppError(cause).message);
    } finally {
      setSubmitting(false);
    }
  }, [email, submitting]);

  if (sent) {
    return (
      <AuthScreenLayout
        title="Check your email"
        subtitle="If that address has a MiniDrama account, a reset link is on its way. The link works once and expires in 30 minutes."
      >
        <Button
          label="I have a reset code"
          onPress={() => router.replace('/reset-password')}
          fullWidth
          size="lg"
        />
        <Button
          label="Back to sign in"
          onPress={() => router.replace('/login')}
          variant="ghost"
          fullWidth
        />
        <AppText variant="caption" tone="tertiary">
          Nothing arrived? Check spam, then try again in a few minutes.
        </AppText>
      </AuthScreenLayout>
    );
  }

  return (
    <AuthScreenLayout
      title="Reset your password"
      subtitle="Enter the email address on your account and we'll send a link to set a new password."
    >
      <FormBanner message={error} tone="error" />

      <FormField
        label="Email"
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        textContentType="emailAddress"
        returnKeyType="send"
        onSubmitEditing={() => void handleSubmit()}
      />

      <Button
        label="Send reset link"
        onPress={() => void handleSubmit()}
        loading={submitting}
        disabled={email.trim().length === 0 || submitting}
        fullWidth
        size="lg"
      />
    </AuthScreenLayout>
  );
}
