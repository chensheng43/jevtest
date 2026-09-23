/**
 * 新建用例：手填表单，或导入一份 case.yaml。两条路并排摆在最上面。
 */

import { el, button, hint } from "../lib/dom.js";
import { call } from "../lib/api.js";
import { utf8Bytes } from "../lib/format.js";
import { busy, errorSlot } from "../ui/feedback.js";
import { pageHead } from "../ui/widgets.js";

/** 服务端的请求体上限（security.ts 的 MAX_BODY_BYTES）。YAML 外面还包着一层 JSON，留点余量 */
const BODY_LIMIT = 8192;

export function viewNew(app) {
  const errors = errorSlot();
  const textarea = el("textarea", {
    class: "form-control mono yaml-input",
    rows: 14,
    spellcheck: "false",
    placeholder: "title: …\ngoal: >-\n  …\nstartUrl: https://…",
    "aria-label": "case.yaml 的内容",
  });
  const sizeNote = el("span", { class: "hint-inline" });
  const fileNote = el("span", { class: "hint-inline" });
  const fileInput = el("input", { type: "file", accept: ".yaml,.yml", class: "d-none" });

  const refreshSize = () => {
    // 按请求体实际的样子算：YAML 包在 {"yaml": "..."} 里，换行与引号会被转义
    const bytes = utf8Bytes(JSON.stringify({ yaml: textarea.value }));
    sizeNote.textContent = textarea.value === "" ? "" : `${bytes} / ${BODY_LIMIT} 字节${bytes > BODY_LIMIT ? "，超过上限，服务端会拒绝" : ""}`;
    sizeNote.classList.toggle("text-danger", bytes > BODY_LIMIT);
  };
  const loadFile = async (file) => {
    if (!file) return;
    textarea.value = await file.text();
    fileNote.textContent = `已读入 ${file.name}`;
    refreshSize();
  };
  textarea.addEventListener("input", refreshSize);
  fileInput.addEventListener("change", () => void loadFile(fileInput.files?.[0]));

  const dropZone = el("div", { class: "drop-zone" }, [
    el("span", { text: "把 .yaml 文件拖到这里，或者" }),
    button("选择文件", { onclick: () => fileInput.click() }),
    fileNote,
  ]);
  const importCard = el("section", { class: "panel import-card" }, [
    el("header", { class: "panel-head" }, [el("div", {}, [
      el("h2", { class: "panel-title", text: "导入 case.yaml" }),
      hint("已经有一份用例文件，或者从别处导出的。id 冲突时**追加 -2 而不是覆盖**已有用例。", "panel-note"),
    ])]),
    el("div", { class: "panel-body" }, [errors.node, dropZone, fileInput, textarea]),
  ]);
  // 拖放：整张卡都是落点。dragover 必须 preventDefault，否则浏览器不会派发 drop
  importCard.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
  importCard.addEventListener("dragleave", () => dropZone.classList.remove("is-dragging"));
  importCard.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
    void loadFile(event.dataTransfer?.files?.[0]);
  });

  const importButton = button("导入", { kind: "primary", size: "" });
  importButton.addEventListener("click", () => busy(importButton, async () => {
    errors.clear();
    if (textarea.value.trim() === "") {
      errors.show(new Error("先粘贴 YAML 内容，或者选一个文件。"), { title: "没有内容可导入" });
      return;
    }
    const revision = await call("/api/cases/import", { method: "POST", body: { yaml: textarea.value } });
    location.hash = `#/case/${revision.caseId}`;
  }, { pending: "正在导入…", onError: (error) => errors.show(error, { title: "导入没有成功" }) }));
  importCard.querySelector(".panel-body").append(el("div", { class: "import-actions" }, [importButton, sizeNote]));

  const formCard = el("section", { class: "panel entry-form" }, [
    el("header", { class: "panel-head" }, [el("div", {}, [
      el("h2", { class: "panel-title", text: "手填一个" }),
      hint("只要标题、目标、起始地址三项就能建一个用例，断言可以之后再加。", "panel-note"),
    ])]),
    el("div", { class: "panel-body" }, [
      el("a", { class: "btn btn-primary", href: "#/case-new-form", text: "打开空白表单" }),
    ]),
  ]);

  app.replaceChildren(
    pageHead("新建用例", { trail: [{ text: "用例", href: "#/cases" }, { text: "新建" }] }),
    el("div", { class: "new-grid" }, [formCard, importCard]),
  );
}
