'use client';

import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter, useSearchParams } from 'next/navigation';
import { FieldError, FormProvider, useForm, useFormContext } from 'react-hook-form';

import { Alert } from '@/components/atoms/Alert/Alert';
import { Button } from '@/components/atoms/Button/Button';
import { LabeledInput } from '@/components/cells/LabeledInput/LabeledInput';
import { transferCart } from '@/lib/data/customer';
import { toast } from '@/lib/helpers/toast';

import { LoginFormData, loginFormSchema } from './schema';

// Neson consumer login (19-4). The marketplace has no email/password
// accounts: a consumer logs in through the phone rail the platform
// bridge owns (18-6). Step 1 requests the one-time code (the mock
// rail returns it); step 2 verifies it — the bridge then exchanges
// the consumer's OpenIM token for the marketplace customer JWT (19-3)
// and the storefront stores it as the Medusa session cookie.
export const LoginForm = () => {
  const methods = useForm<LoginFormData>({
    resolver: zodResolver(loginFormSchema),
    defaultValues: {
      phone: '',
      code: ''
    }
  });

  return (
    <FormProvider {...methods}>
      <Form />
    </FormProvider>
  );
};

const Form = () => {
  const [codeRequested, setCodeRequested] = useState(false);
  const [mockCode, setMockCode] = useState('');
  const {
    handleSubmit,
    register,
    formState: { errors, isSubmitting }
  } = useFormContext();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isSessionExpired = searchParams.get('sessionExpired') === 'true';
  const isSessionRequired = searchParams.get('sessionRequired') === 'true';

  const requestCode = async (data: LoginFormData) => {
    const res = await fetch('/api/consumer/code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: data.phone })
    });
    const out = (await res.json()) as {
      error?: string
      mockCode?: string
    };
    if (!res.ok) {
      toast.error({ title: out.error || 'Unable to request a code.' });
      return;
    }
    setMockCode(out.mockCode ?? '');
    setCodeRequested(true);
  };

  const submit = async (data: LoginFormData) => {
    if (!data.code) {
      toast.error({ title: 'Please enter the code.' });
      return;
    }
    const res = await fetch('/api/consumer/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: data.phone, code: data.code })
    });
    const out = (await res.json()) as { success?: boolean; error?: string };
    if (res.ok && out.success) {
      await transferCart();
      router.push('/user');
    } else {
      toast.error({
        title: out.error || 'Unable to log in. Please try again.'
      });
    }
  };

  const getAuthMessage = () => {
    if (isSessionExpired) {
      return 'Your session has expired. Please log in to continue.';
    }
    if (isSessionRequired) {
      return 'Please log in to continue.';
    }
    return null;
  };

  const authMessage = getAuthMessage();

  return (
    <main
      className="container"
      data-testid="login-page"
    >
      <div className="mx-auto mt-6 w-full max-w-xl space-y-4">
        {authMessage && (
          <Alert
            title={authMessage}
            className="w-full"
            icon
            data-testid="login-auth-alert"
          />
        )}
        <div
          className="rounded-sm border p-4"
          data-testid="login-form-container"
        >
          <h1 className="heading-md mb-8 uppercase text-primary">Log in</h1>
          <form
            onSubmit={codeRequested ? handleSubmit(submit) : handleSubmit(requestCode)}
            data-testid="login-form"
          >
            <div className="space-y-4">
              <LabeledInput
                label="Phone"
                placeholder="+64 21 000 0000"
                error={errors.phone as FieldError | undefined}
                data-testid="login-phone-input"
                {...register('phone')}
              />
              {codeRequested && (
                <LabeledInput
                  label="Code"
                  placeholder="The code we sent"
                  error={errors.code as FieldError | undefined}
                  data-testid="login-code-input"
                  {...register('code')}
                />
              )}
            </div>

            {codeRequested && mockCode && (
              <p
                className="label-md mt-4 text-primary"
                data-testid="login-mock-code"
              >
                Staging fixture code: {mockCode}
              </p>
            )}

            <Button
              className="mt-8 w-full uppercase"
              disabled={isSubmitting}
              data-testid="login-submit-button"
            >
              {codeRequested ? 'Log in' : 'Send code'}
            </Button>

            {codeRequested && (
              <button
                type="button"
                className="label-md mt-4 block w-full uppercase text-action-on-secondary"
                data-testid="login-back-button"
                onClick={() => {
                  setCodeRequested(false);
                  setMockCode('');
                }}
              >
                Use a different number
              </button>
            )}
          </form>
        </div>
      </div>
    </main>
  );
};
