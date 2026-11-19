"use client";

import { Folder, Pencil, Plus, Trash2 } from "lucide-react";

export type NavCategory = { id: number; name: string; count: number; can_delete: boolean };

async function send(path: string, method: string, body?: object) {
  const r = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.ok) return;
  const data = await r.json().catch(() => ({}));
  throw new Error(typeof data.detail === "string" ? data.detail : "Không lưu được danh mục.");
}

/** Category folders column shared by Tài liệu and Notebooks. value: "" = all, "none" = uncategorized, else an id.
 *  `base` is the REST collection (POST creates, PATCH/DELETE `${base}/:id`); `noun` names what a category holds. */
export default function CategoryNav({
  categories,
  value,
  onSelect,
  base,
  noun,
  onChanged,
  onError,
}: {
  categories: NavCategory[];
  value: string;
  onSelect: (v: string) => void;
  base: string;
  noun: string;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  async function action(kind: "create" | "rename" | "delete", c?: NavCategory) {
    try {
      if (kind === "delete" && c) {
        if (!window.confirm(`Xóa danh mục “${c.name}”? ${c.count} ${noun} trong đó sẽ chuyển về Chưa phân loại.`))
          return;
        await send(`${base}/${c.id}`, "DELETE");
        if (value === String(c.id)) onSelect("");
      } else {
        const name = window.prompt(kind === "create" ? "Tên danh mục mới" : "Đổi tên danh mục", c?.name ?? "");
        if (!name?.trim()) return;
        if (kind === "create") await send(base, "POST", { name });
        else if (c) await send(`${base}/${c.id}`, "PATCH", { name });
      }
      onChanged();
    } catch (e) {
      onError(e instanceof Error && e.message ? e.message : "Không lưu được danh mục.");
    }
  }
  return (
    <nav className="panel dc-cats" aria-label="Danh mục">
      <div className="dc-cats-head">DANH MỤC</div>
      <button className={value === "" ? "on" : ""} onClick={() => onSelect("")}>
        <Folder size={14} /> Tất cả
      </button>
      <button className={value === "none" ? "on" : ""} onClick={() => onSelect("none")}>
        <Folder size={14} /> Chưa phân loại
      </button>
      {categories.map((c) => (
        <div key={c.id} className={`dc-cat ${value === String(c.id) ? "on" : ""}`}>
          <button onClick={() => onSelect(String(c.id))} title={c.name}>
            <Folder size={14} /> <span>{c.name}</span> <small>{c.count}</small>
          </button>
          <button className="dc-cat-icon" onClick={() => void action("rename", c)} aria-label={`Đổi tên ${c.name}`}>
            <Pencil size={12} />
          </button>
          {c.can_delete && (
            <button className="dc-cat-icon" onClick={() => void action("delete", c)} aria-label={`Xóa ${c.name}`}>
              <Trash2 size={12} />
            </button>
          )}
        </div>
      ))}
      <button className="dc-cat-add" onClick={() => void action("create")}>
        <Plus size={14} /> Thêm danh mục
      </button>
    </nav>
  );
}
