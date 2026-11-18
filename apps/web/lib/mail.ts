import "server-only";
import nodemailer, { type Transporter } from "nodemailer";

// SMTP_URL, e.g. smtps://you%40gmail.com:<app-password>@smtp.gmail.com:465 (the @ in the user name must be %40).
export const mailConfigured = () => Boolean(process.env.SMTP_URL && process.env.MAIL_FROM);
let transport: Transporter | undefined;

export async function sendMail(to: string, subject: string, text: string, html: string) {
  transport ??= nodemailer.createTransport(process.env.SMTP_URL!);
  await transport.sendMail({ from: process.env.MAIL_FROM, to, subject, text, html });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function resetPasswordMail(name: string, url: string) {
  const text = `Xin chào ${name},\n\nCó yêu cầu đặt lại mật khẩu tài khoản Research OS của bạn. Mở link sau trong vòng 1 giờ để đặt mật khẩu mới:\n\n${url}\n\nNếu bạn không yêu cầu, hãy bỏ qua email này; mật khẩu hiện tại vẫn giữ nguyên.`;
  const html = `<p>Xin chào ${esc(name)},</p><p>Có yêu cầu đặt lại mật khẩu tài khoản Research OS của bạn. Link có hiệu lực trong 1 giờ.</p><p><a href="${esc(url)}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">Đặt mật khẩu mới</a></p><p style="color:#667">Nếu bạn không yêu cầu, hãy bỏ qua email này; mật khẩu hiện tại vẫn giữ nguyên.</p>`;
  return { text, html };
}
