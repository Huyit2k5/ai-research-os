"use client";

import { useMemo } from "react";
import { Download } from "lucide-react";

type Cell = { type: string; source: string; n: number | null };
/** Kaggle stores notebook code as .ipynb JSON (sources only, no outputs); scripts and unknown shapes return null. */
function parseNotebook(code: string): Cell[] | null {
  try {
    const nb = JSON.parse(code) as { cells?: { cell_type?: unknown; source?: unknown; execution_count?: unknown }[] };
    if (!Array.isArray(nb.cells)) return null;
    let n = 0;
    return nb.cells.map((c) => {
      const type = typeof c.cell_type === "string" ? c.cell_type : "raw";
      return {
        type,
        source: Array.isArray(c.source) ? c.source.join("") : typeof c.source === "string" ? c.source : "",
        n: type === "code" ? (typeof c.execution_count === "number" ? c.execution_count : ++n) : null,
      };
    });
  } catch {
    return null;
  }
}
const PY_TOKEN =
  /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|#[^\n]*|\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield)\b|\b\d+(?:\.\d+)?(?:e[-+]?\d+)?\b)/g;
// Tokens are rendered as React text, so notebook content is never interpreted as HTML.
function highlight(src: string) {
  return src.split(PY_TOKEN).map((part, i) =>
    i % 2 === 0 ? (
      part
    ) : (
      <span
        key={i}
        className={part.startsWith("#") ? "py-c" : /^["']/.test(part) ? "py-s" : /^\d/.test(part) ? "py-n" : "py-k"}
      >
        {part}
      </span>
    ),
  );
}
// Inline **bold** and `code`; everything stays React text (no HTML from the notebook is rendered).
function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
    i % 2 === 0 ? (
      part
    ) : part.startsWith("**") ? (
      <b key={i}>{part.slice(2, -2)}</b>
    ) : (
      <code key={i} className="nb-inline">
        {part.slice(1, -1)}
      </code>
    ),
  );
}
const cellsOf = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
export function Markdown({ src }: { src: string }) {
  const out: React.ReactNode[] = [];
  src.split(/(```[\s\S]*?```)/g).forEach((block, i) => {
    if (block.startsWith("```")) {
      out.push(
        <pre key={i} className="nb-md-code">
          {block.replace(/^```\w*\n?|```$/g, "")}
        </pre>,
      );
      return;
    }
    const lines = block.split("\n");
    for (let j = 0; j < lines.length; j++) {
      const line = lines[j],
        h = /^(#{1,6})\s+(.*)$/.exec(line);
      // A pipe table: header row, then a |---| separator, then body rows.
      if (line.trim().startsWith("|") && /^\s*\|?\s*:?-{3,}/.test(lines[j + 1] ?? "")) {
        const head = cellsOf(line),
          body: string[][] = [];
        j += 2;
        while (j < lines.length && lines[j].trim().startsWith("|")) body.push(cellsOf(lines[j++]));
        j--;
        out.push(
          <div key={`${i}-${j}`} className="nb-table">
            <table>
              <thead>
                <tr>
                  {head.map((c, k) => (
                    <th key={k}>{inline(c)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.map((r, k) => (
                  <tr key={k}>
                    {r.map((c, m) => (
                      <td key={m}>{inline(c)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
      } else
        out.push(
          h ? (
            <div key={`${i}-${j}`} className={`nb-h nb-h${h[1].length}`}>
              {inline(h[2])}
            </div>
          ) : (
            <div key={`${i}-${j}`} className="nb-md-line">
              {line ? inline(line) : " "}
            </div>
          ),
        );
    }
  });
  return <>{out}</>;
}
export default function NotebookView({ code, name }: { code: string; name: string }) {
  const cells = useMemo(() => parseNotebook(code), [code]);
  function download() {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([code], { type: cells ? "application/x-ipynb+json" : "text/plain" }));
    a.download = `${
      name
        .replace(/[^\p{L}\p{N}_.-]+/gu, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 100) || "notebook"
    }.${cells ? "ipynb" : "py"}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  return (
    <div className="nb">
      <div className="nb-bar">
        <span className="rn-muted">{cells ? `${cells.length} cell` : "Script"}</span>
        <button className="rn-link" onClick={download}>
          <Download size={13} /> Tải {cells ? ".ipynb" : "file"}
        </button>
      </div>
      {cells ? (
        <div className="nb-cells">
          {cells.map((c, i) =>
            c.type === "code" ? (
              <div key={i} className="nb-cell code">
                <div className="nb-gutter">[{c.n}]</div>
                <pre className="nb-src">{highlight(c.source)}</pre>
              </div>
            ) : (
              <div key={i} className={`nb-cell ${c.type === "markdown" ? "md" : "raw"}`}>
                <div className="nb-gutter" />
                <div className="nb-md">
                  {c.type === "markdown" ? <Markdown src={c.source} /> : <pre className="nb-src">{c.source}</pre>}
                </div>
              </div>
            ),
          )}
        </div>
      ) : (
        <pre className="rn-code">{highlight(code)}</pre>
      )}
    </div>
  );
}
