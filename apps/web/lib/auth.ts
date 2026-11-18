import "server-only";
import { createHmac } from "node:crypto";
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins";
import { db } from "./server";
import { mailConfigured, resetPasswordMail, sendMail } from "./mail";

const encryptionKey = process.env.CREDENTIAL_ENCRYPTION_KEY || "";
const secret = process.env.BETTER_AUTH_SECRET || (encryptionKey ? createHmac("sha256", encryptionKey).update("research-os-auth-v1").digest("hex") : undefined);

export const auth = betterAuth({
  database: db,
  secret,
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
  // Password reset is only offered when SMTP is configured; a reset signs the user out everywhere.
  emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128, revokeSessionsOnPasswordReset: true, resetPasswordTokenExpiresIn: 60 * 60,
    ...(mailConfigured() ? { sendResetPassword: async ({ user, url }: { user: { email: string; name: string }; url: string }) => { const m = resetPasswordMail(user.name, url); await sendMail(user.email, "Đặt lại mật khẩu Research OS", m.text, m.html); } } : {}) },
  rateLimit: { enabled: true, window: 60, max: 20 },
  plugins: [organization({ invitationExpiresIn: 7 * 24 * 60 * 60, disableOrganizationDeletion: true }), nextCookies()],
});
