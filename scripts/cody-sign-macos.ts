import { sign as signApplication, type SignOptions } from "@electron/osx-sign";

// Squirrel.Mac installs an update only when it meets the running app's designated requirement.
// An ad hoc signature never does, so Cody signs every build with one self-signed certificate.
export default async function sign(options: SignOptions): Promise<void> {
  const identity = process.env.CODY_MAC_SIGN_IDENTITY?.trim();
  if (!identity) throw new Error("CODY_MAC_SIGN_IDENTITY is not set.");
  const keychain = process.env.CODY_MAC_SIGN_KEYCHAIN?.trim();
  await signApplication({
    ...options,
    identity,
    identityValidation: false,
    ...(keychain ? { keychain } : {}),
    batchCodesignCalls: true,
  });
}
