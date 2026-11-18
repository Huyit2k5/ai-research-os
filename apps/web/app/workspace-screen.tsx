"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Check, Copy, LogOut, Plus, Trash2, UserPlus, Users, X } from "lucide-react";
import { authClient } from "../lib/auth-client";

export type Workspace = { id: string; name: string; role: string };
type Full = {
  members: { id: string; userId: string; role: string; user: { name: string; email: string } }[];
  invitations: { id: string; email: string; status: string; expiresAt: string | Date }[];
};
type Result = { error: { code?: string; message?: string } | null };

const errors: Record<string, string> = {
  USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION: "Người này đã là thành viên.",
  USER_IS_ALREADY_INVITED_TO_THIS_ORGANIZATION: "Email này đã có lời mời đang chờ.",
  YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION:
    "Lời mời này dành cho email khác. Hãy đăng nhập bằng đúng email được mời.",
  INVITATION_NOT_FOUND: "Lời mời không tồn tại, đã hết hạn hoặc đã được dùng.",
  YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER: "Bạn là owner duy nhất nên không thể rời workspace.",
  YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION: "Chỉ owner hoặc admin mới được mời thành viên.",
};
export function orgError(error: Result["error"]) {
  return (error?.code && errors[error.code]) || "Thao tác không thành công. Vui lòng thử lại.";
}
const roles: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Thành viên" };
const inviteLink = (id: string) => `${window.location.origin}/?invite=${encodeURIComponent(id)}`;

export default function WorkspaceScreen({ workspace, userId }: { workspace: Workspace; userId: string }) {
  const { data: workspaces } = authClient.useListOrganizations();
  const [full, setFull] = useState<Full | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const admin = ["owner", "admin"].includes(workspace.role);
  const load = useCallback(async () => {
    const r = await authClient.organization.getFullOrganization({ query: { organizationId: workspace.id } });
    if (r.error) setError(orgError(r.error));
    else setFull(r.data as Full | null);
  }, [workspace.id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<Result>, done: string, reload = false) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await action();
      if (r.error) {
        setError(orgError(r.error));
        return;
      }
      if (reload) {
        window.location.assign("/");
        return;
      }
      setNotice(done);
      await load();
    } catch {
      setError("Không thể kết nối máy chủ. Vui lòng thử lại.");
    } finally {
      setBusy(false);
    }
  }
  async function copy(id: string) {
    try {
      await navigator.clipboard.writeText(inviteLink(id));
      setNotice("Đã copy link mời. Gửi link này cho người được mời.");
    } catch {
      setError(`Không copy được. Link mời: ${inviteLink(id)}`);
    }
  }
  function invite(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const r = await authClient.organization.inviteMember({
        email: email.trim(),
        role: "member",
        organizationId: workspace.id,
      });
      if (!r.error) {
        setEmail("");
        if (r.data) await copy(r.data.id);
      }
      return r;
    }, "Đã tạo lời mời và copy link. Gửi link cho người được mời; họ cần đăng nhập đúng email đó.");
  }
  function create(event: FormEvent) {
    event.preventDefault();
    void run(() => authClient.organization.create({ name: name.trim(), slug: `ws-${crypto.randomUUID()}` }), "", true);
  }
  const pending = full?.invitations.filter((item) => item.status === "pending") ?? [];

  return (
    <>
      <div className="heading screen-heading">
        <div>
          <div className="eyebrow">
            <span /> WORKSPACE
          </div>
          <h1>{workspace.name}</h1>
          <p>
            Thành viên cùng thấy danh sách kết nối Kaggle của workspace. Mọi thành viên đều dùng được kết nối để đồng
            bộ, xem logs và thu run; token không bao giờ hiển thị, và chỉ người tạo hoặc quản trị mới đổi được.
          </p>
        </div>
      </div>
      {error && (
        <div className="alert error" role="alert">
          {error}
          <button onClick={() => setError("")} aria-label="Đóng">
            <X size={16} />
          </button>
        </div>
      )}
      {notice && (
        <div className="alert success">
          <Check size={17} />
          {notice}
          <button onClick={() => setNotice("")} aria-label="Đóng">
            <X size={16} />
          </button>
        </div>
      )}
      <section className="panel ws-panel">
        <div className="panel-heading">
          <div>
            <h2>
              Thành viên <span className="count">{full?.members.length ?? "—"}</span>
            </h2>
            <p>Vai trò của bạn: {roles[workspace.role] ?? workspace.role}</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>THÀNH VIÊN</th>
                <th>VAI TRÒ</th>
                <th>THAO TÁC</th>
              </tr>
            </thead>
            <tbody>
              {full?.members.map((member) => (
                <tr key={member.id}>
                  <td>
                    <div className="account">
                      <span className="kaggle">
                        <Users size={15} />
                      </span>
                      <div>
                        <b>
                          {member.user.name}
                          {member.userId === userId && " (bạn)"}
                        </b>
                        <small>{member.user.email}</small>
                      </div>
                    </div>
                  </td>
                  <td className="time">{roles[member.role] ?? member.role}</td>
                  <td>
                    <div className="actions">
                      {member.userId === userId
                        ? workspace.role !== "owner" && (
                            <button
                              disabled={busy}
                              onClick={() => {
                                if (window.confirm(`Rời workspace “${workspace.name}”?`))
                                  void run(
                                    () => authClient.organization.leave({ organizationId: workspace.id }),
                                    "",
                                    true,
                                  );
                              }}
                            >
                              <LogOut size={14} /> Rời workspace
                            </button>
                          )
                        : admin &&
                          member.role !== "owner" && (
                            <button
                              className="delete"
                              disabled={busy}
                              onClick={() => {
                                if (window.confirm(`Xóa ${member.user.name} khỏi workspace?`))
                                  void run(
                                    () =>
                                      authClient.organization.removeMember({
                                        memberIdOrEmail: member.id,
                                        organizationId: workspace.id,
                                      }),
                                    "Đã xóa thành viên.",
                                  );
                              }}
                              aria-label={`Xóa ${member.user.name}`}
                            >
                              <Trash2 size={15} />
                            </button>
                          )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {admin && (
        <section className="panel ws-panel">
          <div className="panel-heading">
            <div>
              <h2>Mời thành viên</h2>
              <p>Tạo link mời theo email, rồi gửi link cho người đó (Zalo, chat…). Link hết hạn sau 7 ngày.</p>
            </div>
          </div>
          <form className="ws-form" onSubmit={invite}>
            <input
              required
              type="email"
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="email@cua-dong-doi.com"
              aria-label="Email người được mời"
            />
            <button className="primary secondary" disabled={busy}>
              <UserPlus size={16} /> Tạo link mời
            </button>
          </form>
          {pending.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>LỜI MỜI ĐANG CHỜ</th>
                    <th>HẾT HẠN</th>
                    <th>THAO TÁC</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map((item) => (
                    <tr key={item.id}>
                      <td className="time">{item.email}</td>
                      <td className="time">{new Date(item.expiresAt).toLocaleString("vi-VN")}</td>
                      <td>
                        <div className="actions">
                          <button onClick={() => void copy(item.id)}>
                            <Copy size={14} /> Copy link
                          </button>
                          <button
                            className="delete"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                () => authClient.organization.cancelInvitation({ invitationId: item.id }),
                                "Đã hủy lời mời.",
                              )
                            }
                          >
                            <X size={14} /> Hủy
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      <section className="panel ws-panel">
        <div className="panel-heading">
          <div>
            <h2>Workspace của bạn</h2>
            <p>Chuyển workspace hoặc tạo workspace mới cho nhóm.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <tbody>
              {workspaces?.map((item) => (
                <tr key={item.id}>
                  <td>
                    <b>{item.name}</b>
                  </td>
                  <td>
                    <div className="actions">
                      {item.id === workspace.id ? (
                        <span className="badge verified">
                          <span /> Đang dùng
                        </span>
                      ) : (
                        <button
                          disabled={busy}
                          onClick={() =>
                            void run(() => authClient.organization.setActive({ organizationId: item.id }), "", true)
                          }
                        >
                          Chuyển sang
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form className="ws-form" onSubmit={create}>
          <input
            required
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Tên workspace mới, ví dụ: Nhóm NCKH"
            aria-label="Tên workspace mới"
          />
          <button className="secondary" disabled={busy}>
            <Plus size={16} /> Tạo workspace
          </button>
        </form>
      </section>
    </>
  );
}

export function AcceptInvite({ id }: { id: string }) {
  const [invitation, setInvitation] = useState<{ organizationName: string; inviterEmail: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void authClient.organization
      .getInvitation({ query: { id } })
      .then((r) => (r.error ? setError(orgError(r.error)) : setInvitation(r.data)))
      .catch(() => setError("Không thể kết nối máy chủ. Vui lòng thử lại."));
  }, [id]);
  async function answer(accept: boolean) {
    setBusy(true);
    setError("");
    try {
      const r = accept
        ? await authClient.organization.acceptInvitation({ invitationId: id })
        : await authClient.organization.rejectInvitation({ invitationId: id });
      if (r.error) {
        setError(orgError(r.error));
        return;
      }
      if (accept && r.data && "member" in r.data && r.data.member)
        await authClient.organization.setActive({ organizationId: r.data.member.organizationId });
      window.location.assign("/");
    } catch {
      setError("Không thể kết nối máy chủ. Vui lòng thử lại.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-loading">
      <div className="panel ws-invite">
        <div className="eyebrow">LỜI MỜI WORKSPACE</div>
        {invitation ? (
          <>
            <h2>Tham gia “{invitation.organizationName}”</h2>
            <p>{invitation.inviterEmail} mời bạn vào workspace này. Bạn sẽ thấy các kết nối Kaggle của nhóm.</p>
            <div className="modal-actions">
              <button className="secondary" disabled={busy} onClick={() => void answer(false)}>
                Từ chối
              </button>
              <button className="primary secondary" disabled={busy} onClick={() => void answer(true)}>
                {busy ? "Đang xử lý..." : "Tham gia"}
              </button>
            </div>
          </>
        ) : (
          !error && <p>Đang tải lời mời...</p>
        )}
        {error && (
          <>
            <div className="alert error" role="alert">
              {error}
            </div>
            <button className="secondary" onClick={() => window.location.assign("/")}>
              Về trang chính
            </button>
          </>
        )}
      </div>
    </div>
  );
}
