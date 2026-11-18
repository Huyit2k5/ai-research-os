// Pure SaveKernel request building (no server imports, so tests/save-kernel.test.mjs loads it directly).
// Kaggle drops every attached source that a new version does not resend (verified 2026-11-18), so unspecified fields inherit from the current version.
export type Machine = "t4x2" | "l4" | "tpu" | "cpu";
export type PushSettings = {
  machine?: Machine;
  enable_internet?: boolean;
  is_private?: boolean;
  dataset_sources?: string[];
  competition_sources?: string[];
  kernel_sources?: string[];
  model_sources?: string[];
};
export const MACHINES: Record<Machine, string> = { t4x2: "NvidiaTeslaT4", l4: "NvidiaL4", tpu: "TpuV5E8", cpu: "" };
export const MAX_CODE = 2 * 1024 * 1024;
const SOURCES = [
  ["dataset_sources", "datasetDataSources"],
  ["competition_sources", "competitionDataSources"],
  ["kernel_sources", "kernelDataSources"],
  ["model_sources", "modelDataSources"],
] as const;
const SOURCE = /^[A-Za-z0-9_.\/-]{1,200}$/;

export function parseSettings(raw: unknown): PushSettings {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("Cấu hình chạy không hợp lệ.");
  const r = raw as Record<string, unknown>,
    out: PushSettings = {};
  if (r.machine !== undefined) {
    if (typeof r.machine !== "string" || !(r.machine in MACHINES))
      throw new Error("Loại máy không hợp lệ. Dùng t4x2, l4, tpu hoặc cpu.");
    out.machine = r.machine as Machine;
  }
  for (const k of ["enable_internet", "is_private"] as const)
    if (r[k] !== undefined) {
      if (typeof r[k] !== "boolean") throw new Error(`${k} phải là true hoặc false.`);
      out[k] = r[k];
    }
  for (const [k] of SOURCES)
    if (r[k] !== undefined) {
      const v = r[k];
      if (!Array.isArray(v) || v.length > 20 || !v.every((s) => typeof s === "string" && SOURCE.test(s)))
        throw new Error(`${k} phải là danh sách tối đa 20 mục dạng owner/slug.`);
      out[k] = [...v];
    }
  return out;
}

export function validateCode(code: unknown, kernelType: "notebook" | "script"): string {
  if (typeof code !== "string" || !code.trim()) throw new Error("Thiếu code.");
  if (Buffer.byteLength(code, "utf8") > MAX_CODE) throw new Error("Code vượt quá 2 MB.");
  if (kernelType === "notebook") {
    let nb: unknown;
    try {
      nb = JSON.parse(code);
    } catch {
      nb = null;
    }
    if (!nb || typeof nb !== "object" || !Array.isArray((nb as { cells?: unknown }).cells))
      throw new Error("Code notebook phải là JSON .ipynb có mảng cells.");
  }
  return code;
}

export function buildSaveKernelBody(input: {
  ref: string | null;
  newTitle: string | null;
  kernelType: "notebook" | "script";
  code: string;
  settings: PushSettings;
  current: Record<string, unknown> | null;
}): Record<string, unknown> {
  const { ref, newTitle, kernelType, code, settings: s, current: c } = input;
  const inherited = typeof c?.machineShape === "string" && c.machineShape !== "None" ? c.machineShape : "";
  const shape = s.machine ? MACHINES[s.machine] : inherited || (c?.enableGpu === true ? MACHINES.t4x2 : "");
  const tpu = s.machine ? s.machine === "tpu" : c?.enableTpu === true;
  const body: Record<string, unknown> = {
    ...(ref ? { slug: ref } : { newTitle }),
    text: code,
    language: "python",
    kernelType,
    isPrivate: s.is_private ?? (typeof c?.isPrivate === "boolean" ? c.isPrivate : true),
    enableGpu: !!shape && !tpu,
    enableTpu: tpu,
    enableInternet: s.enable_internet ?? c?.enableInternet === true,
    kernelExecutionType: "SaveAndRunAll",
    ...(shape ? { machineShape: shape } : {}),
  };
  for (const [k, field] of SOURCES) body[field] = s[k] ?? (Array.isArray(c?.[field]) ? c[field] : []);
  return body;
}

/** SaveKernel answers ref as "/code/<owner>/<slug>". */
export function savedRef(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const ref = raw.replace(/^\/?code\//, "").replace(/^\//, "");
  return /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(ref) ? ref : null;
}
