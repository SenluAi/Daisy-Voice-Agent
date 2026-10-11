export const LICENSE_APP_ID = "com.daisy.app";
export const LICENSE_ISSUER = "https://daisy-voice.pages.dev";
export const LICENSE_PUBLIC_KEY = "MCowBQYDK2VwAyEAkm4PtAnV078DXFn8n3xurmY+nL1gvFuYNC1bokdr00g=";
export const TRIAL_SECONDS = 7 * 24 * 60 * 60;
export const LEASE_SECONDS = 24 * 60 * 60;
export const LICENSE_REFRESH_MS = 60 * 60 * 1000;

export interface AccessClaims {
  v: 2;
  iss: typeof LICENSE_ISSUER;
  aud: typeof LICENSE_APP_ID;
  sub: string;
  edition: "trial" | "full";
  licenseId: string;
  iat: number;
  exp: number;
  trialStartedAt: number | null;
  trialExpiresAt: number | null;
  nonce: string;
}

export interface LicenseAccessStatus {
  allowed: boolean;
  accessState: "checking" | "trial" | "activated" | "expired" | "verification_required";
  trialStartedAt?: number;
  trialExpiresAt?: number;
  remainingTrialMs: number;
  leaseExpiresAt?: number;
  accessMessage: string;
}
