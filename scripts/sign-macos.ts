import { sign as signApplication, type SignOptions } from "@electron/osx-sign";

export default async function sign(options: SignOptions): Promise<void> {
  const adHoc = options.identity === "-" || process.env.CSC_IDENTITY_AUTO_DISCOVERY === "false";
  if (adHoc) {
    const { keychain: _keychain, provisioningProfile: _provisioningProfile, ...rest } = options;
    await signApplication({
      ...rest,
      batchCodesignCalls: true,
      identity: "-",
      identityValidation: false,
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
    });
    return;
  }
  await signApplication({ ...options, batchCodesignCalls: true });
}
