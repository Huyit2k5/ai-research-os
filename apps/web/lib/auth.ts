import "server-only";
import { createHmac } from "node:crypto";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";
import { db } from "./server";

const encryptionKey = process.env.CREDENTIAL_ENCRYPTION_KEY || "";
const secret = process.env.BETTER_AUTH_SECRET || (encryptionKey ? createHmac("sha256", encryptionKey).update("research-os-auth-v1").digest("hex") : undefined);

export const auth = betterAuth({
  database: db,
  secret,
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
  emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128 },
  rateLimit: { enabled: true, window: 60, max: 20 },
  plugins: [organization({ invitationExpiresIn: 7 * 24 * 60 * 60 }), nextCookies()],
});
