"use client";

import { useState, type FormEvent } from "react";
import { ArrowRight, FlaskConical, LockKeyhole, ShieldCheck, Sparkles } from "lucide-react";
import { authClient } from "../lib/auth-client";

export default function AuthScreen() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault(); setError(""); setBusy(true);
    try {
      const result = mode === "register"
        ? await authClient.signUp.email({ name: name.trim(), email: email.trim(), password })
        : await authClient.signIn.email({ email: email.trim(), password });
      if (result.error) setError(mode === "login" ? "Không thể đăng nhập. Kiểm tra email và mật khẩu." : "Không thể tạo tài khoản. Kiểm tra thông tin hoặc thử email khác.");
    } catch { setError("Không thể kết nối máy chủ. Vui lòng thử lại."); }
    finally { setBusy(false); }
  }
  return <div className="auth-layout"><section className="auth-intro"><div className="auth-brand"><span className="brand-icon">✳</span><strong>Research OS</strong></div><div className="auth-intro-body"><div className="auth-kicker"><Sparkles size={15}/> YOUR RESEARCH, ORGANIZED</div><h1>Một không gian<br/>cho những ý tưởng<br/><span>lớn hơn.</span></h1><p>Kết nối công cụ, theo dõi thí nghiệm và tập trung vào điều quan trọng nhất: nghiên cứu của bạn.</p><div className="auth-perks"><div><span><FlaskConical size={18}/></span><div><b>Quản lý thí nghiệm</b><small>Theo dõi công việc nghiên cứu ở một nơi</small></div></div><div><span><ShieldCheck size={18}/></span><div><b>Không gian riêng tư</b><small>Các kết nối được gắn với tài khoản của bạn</small></div></div></div></div><div className="auth-intro-footer">AI RESEARCH OS <span>·</span> XÂY DỰNG CHO NGƯỜI NGHIÊN CỨU</div></section><main className="auth-main"><div className="auth-card"><div className="auth-card-icon"><LockKeyhole size={22}/></div><div className="eyebrow">CHÀO MỪNG ĐẾN RESEARCH OS</div><h2>{mode === "login" ? "Đăng nhập" : "Tạo tài khoản"}</h2><p>{mode === "login" ? "Đăng nhập để tiếp tục công việc nghiên cứu của bạn." : "Tạo tài khoản riêng cho không gian nghiên cứu."}</p><div className="auth-tabs"><button type="button" className={mode === "login" ? "active" : ""} onClick={() => { setMode("login"); setError(""); }}>Đăng nhập</button><button type="button" className={mode === "register" ? "active" : ""} onClick={() => { setMode("register"); setError(""); }}>Tạo tài khoản</button></div>{error && <div className="alert error" role="alert">{error}</div>}<form onSubmit={submit}>{mode === "register" && <label>Họ tên<input required maxLength={100} autoComplete="name" value={name} onChange={event => setName(event.target.value)} placeholder="Tên của bạn" /></label>}<label>Email<input required type="email" maxLength={254} autoComplete="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="ban@example.com" /></label><label>Mật khẩu<input required type="password" minLength={12} maxLength={128} autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={event => setPassword(event.target.value)} placeholder="Nhập mật khẩu" />{mode === "register" && <small>Tối thiểu 12 ký tự.</small>}</label><button className="primary auth-submit" disabled={busy}>{busy ? "Đang xử lý..." : mode === "login" ? "Đăng nhập" : "Tạo tài khoản"}<ArrowRight size={16}/></button></form><div className="auth-note"><ShieldCheck size={15}/> Đây là tài khoản Research OS, không phải mật khẩu Kaggle.</div></div></main></div>;
}
