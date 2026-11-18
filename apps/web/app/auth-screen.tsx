"use client";

import { useState, type FormEvent } from "react";
import { ArrowRight, FlaskConical, LockKeyhole, ShieldCheck, Sparkles } from "lucide-react";
import { authClient } from "../lib/auth-client";

export default function AuthScreen() {
  // A reset link lands on /?reset=1&token=… (or &error=INVALID_TOKEN when expired/used).
  const params = typeof window === "undefined" ? null : new URLSearchParams(window.location.search);
  const resetToken = params?.get("reset") ? params.get("token") : null;
  const [mode, setMode] = useState<"login" | "register" | "forgot" | "reset">(resetToken ? "reset" : "login");
  const [confirm, setConfirm] = useState("");
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(
    params?.get("reset") && params.get("error")
      ? "Link đặt lại mật khẩu không hợp lệ hoặc đã hết hạn. Hãy yêu cầu link mới."
      : "",
  );
  const go = (next: typeof mode) => {
    setMode(next);
    setError("");
    setNotice("");
    setPassword("");
    setConfirm("");
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setNotice("");
    setBusy(true);
    try {
      if (mode === "forgot") {
        const result = await authClient.requestPasswordReset({ email: email.trim(), redirectTo: "/?reset=1" });
        if (result.error)
          setError(
            result.error.status === 429
              ? "Bạn đã yêu cầu quá nhiều lần. Hãy thử lại sau 1 phút."
              : "Chưa gửi được email đặt lại mật khẩu. Máy chủ có thể chưa cấu hình email; hãy liên hệ quản trị viên.",
          );
        else
          setNotice(
            "Nếu email này có tài khoản, link đặt lại mật khẩu đã được gửi. Link có hiệu lực trong 1 giờ; hãy kiểm tra cả thư mục Spam.",
          );
        return;
      }
      if (mode === "reset") {
        if (password !== confirm) {
          setError("Hai lần nhập mật khẩu không khớp.");
          return;
        }
        const result = await authClient.resetPassword({ newPassword: password, token: resetToken ?? "" });
        if (result.error) {
          setError("Không thể đặt lại mật khẩu. Link có thể đã hết hạn hoặc đã được dùng.");
          return;
        }
        window.history.replaceState(null, "", "/");
        go("login");
        setNotice("Đã đặt mật khẩu mới. Hãy đăng nhập lại.");
        return;
      }
      const result =
        mode === "register"
          ? await authClient.signUp.email({ name: name.trim(), email: email.trim(), password })
          : await authClient.signIn.email({ email: email.trim(), password });
      if (result.error)
        setError(
          mode === "login"
            ? "Không thể đăng nhập. Kiểm tra email và mật khẩu."
            : "Không thể tạo tài khoản. Kiểm tra thông tin hoặc thử email khác.",
        );
    } catch {
      setError("Không thể kết nối máy chủ. Vui lòng thử lại.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-layout">
      <section className="auth-intro">
        <div className="auth-brand">
          <span className="brand-icon">✳</span>
          <strong>Research OS</strong>
        </div>
        <div className="auth-intro-body">
          <div className="auth-kicker">
            <Sparkles size={15} /> YOUR RESEARCH, ORGANIZED
          </div>
          <h1>
            Một không gian
            <br />
            cho những ý tưởng
            <br />
            <span>lớn hơn.</span>
          </h1>
          <p>Kết nối công cụ, theo dõi thí nghiệm và tập trung vào điều quan trọng nhất: nghiên cứu của bạn.</p>
          <div className="auth-perks">
            <div>
              <span>
                <FlaskConical size={18} />
              </span>
              <div>
                <b>Quản lý thí nghiệm</b>
                <small>Theo dõi công việc nghiên cứu ở một nơi</small>
              </div>
            </div>
            <div>
              <span>
                <ShieldCheck size={18} />
              </span>
              <div>
                <b>Không gian riêng tư</b>
                <small>Các kết nối được gắn với tài khoản của bạn</small>
              </div>
            </div>
          </div>
        </div>
        <div className="auth-intro-footer">
          AI RESEARCH OS <span>·</span> XÂY DỰNG CHO NGƯỜI NGHIÊN CỨU
        </div>
      </section>
      <main className="auth-main">
        <div className="auth-card">
          <div className="auth-card-icon">
            <LockKeyhole size={22} />
          </div>
          <div className="eyebrow">CHÀO MỪNG ĐẾN RESEARCH OS</div>
          <h2>
            {
              { login: "Đăng nhập", register: "Tạo tài khoản", forgot: "Quên mật khẩu", reset: "Đặt mật khẩu mới" }[
                mode
              ]
            }
          </h2>
          <p>
            {
              {
                login: "Đăng nhập để tiếp tục công việc nghiên cứu của bạn.",
                register: "Tạo tài khoản riêng cho không gian nghiên cứu.",
                forgot: "Nhập email đã đăng ký, chúng tôi sẽ gửi link đặt lại mật khẩu.",
                reset: "Nhập mật khẩu mới cho tài khoản. Mọi phiên đăng nhập cũ sẽ bị đăng xuất.",
              }[mode]
            }
          </p>
          <div className="auth-tabs">
            <button type="button" className={mode === "login" ? "active" : ""} onClick={() => go("login")}>
              Đăng nhập
            </button>
            <button type="button" className={mode === "register" ? "active" : ""} onClick={() => go("register")}>
              Tạo tài khoản
            </button>
          </div>
          {error && (
            <div className="alert error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="alert success" role="status">
              {notice}
            </div>
          )}
          <form onSubmit={submit}>
            {mode === "register" && (
              <label>
                Họ tên
                <input
                  required
                  maxLength={100}
                  autoComplete="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Tên của bạn"
                />
              </label>
            )}
            {mode !== "reset" && (
              <label>
                Email
                <input
                  required
                  type="email"
                  maxLength={254}
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="ban@example.com"
                />
              </label>
            )}
            {mode !== "forgot" && (
              <label>
                {mode === "reset" ? "Mật khẩu mới" : "Mật khẩu"}
                <input
                  required
                  type="password"
                  minLength={12}
                  maxLength={128}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Nhập mật khẩu"
                />
                {mode !== "login" && <small>Tối thiểu 12 ký tự.</small>}
              </label>
            )}
            {mode === "reset" && (
              <label>
                Nhập lại mật khẩu mới
                <input
                  required
                  type="password"
                  minLength={12}
                  maxLength={128}
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  placeholder="Nhập lại mật khẩu"
                />
              </label>
            )}
            {mode === "login" && (
              <button type="button" className="auth-link" onClick={() => go("forgot")}>
                Quên mật khẩu?
              </button>
            )}
            <button className="primary auth-submit" disabled={busy}>
              {busy
                ? "Đang xử lý..."
                : {
                    login: "Đăng nhập",
                    register: "Tạo tài khoản",
                    forgot: "Gửi link đặt lại",
                    reset: "Đặt mật khẩu mới",
                  }[mode]}
              <ArrowRight size={16} />
            </button>
          </form>
          {(mode === "forgot" || mode === "reset") && (
            <button
              type="button"
              className="auth-link"
              onClick={() => {
                window.history.replaceState(null, "", "/");
                go("login");
              }}
            >
              ← Quay lại đăng nhập
            </button>
          )}
          <div className="auth-note">
            <ShieldCheck size={15} /> Đây là tài khoản Research OS, không phải mật khẩu Kaggle.
          </div>
        </div>
      </main>
    </div>
  );
}
