import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
if (process.env.GOOGLE_SECRETENV_PATH) {
  try {
    const client = new SecretManagerServiceClient();
    const [key] = await client.accessSecretVersion({
      name: `${process.env.GOOGLE_SECRETENV_PATH}_KEY/versions/latest`
    });
    process.env.SECRETENV_KEY = key.payload?.data?.toString('utf8');
    const [bundle] = await client.accessSecretVersion({
      name: `${process.env.GOOGLE_SECRETENV_PATH}_BUNDLE/versions/latest`
    });
    process.env.SECRETENV_BUNDLE = bundle.payload?.data?.toString('utf8');
    console.log('Google secret injection succeeded');
  } catch (err) {
    console.error('Google secret injection failed:', err instanceof Error ? err.message : String(err));
  }
}