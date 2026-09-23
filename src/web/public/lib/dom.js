/**
 * DOM 构造。全前端只有这一种造节点的方式。
 *
 * 底线：**所有动态文本走 `textContent`，不用 `innerHTML`。**
 * 用例内容（goal、label、断言文案）是用户写的文件内容，可能有尖括号；trace、事件、
 * 报告里的字符串同理。服务只监听 127.0.0.1，但「本地」不等于「安全」——
 * 同一个浏览器里的别的页面够得着它。
 */

/** 创建元素。所有动态文本走 `text:`（textContent），绝不拼 HTML。 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") throw new Error("不用 innerHTML：动态文本一律走 textContent");
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "value") node.value = String(value);
    else if (key === "checked") node.checked = Boolean(value);
    else if (key === "hidden") node.hidden = Boolean(value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

/**
 * 换掉一个节点的全部子节点。**构建列表时一律用它，不要直接调 `replaceChildren`。**
 *
 * `replaceChildren` 对每个参数做 `(Node | DOMString)` 转换：传数组会渲染出
 * `[object HTMLDivElement],…`，传 `null` 会渲染出字面的 "null"，两种都不报错。
 * 这里只收一个数组、滤掉空值，字符串直接抛错——拼错了要当场响。
 */
export function setChildren(node, children) {
  const list = [];
  for (const child of [].concat(children)) {
    if (typeof child === "string") {
      throw new Error(`子节点不能是字符串（"${child}"）：文本请用 el("span", { text }) 或 rich()`);
    }
    if (child) list.push(child);
  }
  node.replaceChildren(...list);
  return node;
}

/**
 * 行内富文本：`**强调**` 渲染成 <strong>，`` `代码` `` 渲染成 <code>。
 *
 * 只认这两种记号，且只用于本仓库里写死的文案——用户内容一律走 `text:`。
 * 以前这类文案有一半是直接塞进 textContent 的，于是页面上出现字面的 `**` 与反引号；
 * 现在凡是带记号的文案都走这里，不再有第二条路。
 */
export function rich(text, tag = "span", props = {}) {
  const node = el(tag, props);
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (const match of String(text).matchAll(pattern)) {
    if (match.index > last) node.append(document.createTextNode(text.slice(last, match.index)));
    node.append(match[1] !== undefined ? el("strong", { text: match[1] }) : el("code", { text: match[2] }));
    last = match.index + match[0].length;
  }
  if (last < text.length) node.append(document.createTextNode(text.slice(last)));
  return node;
}

/** 提示段落（灰色小字）。文案可带 `**` 与反引号记号。 */
export function hint(text, extraClass = "") {
  return rich(text, "p", { class: extraClass === "" ? "hint" : `hint ${extraClass}` });
}

// ---------------------------------------------------------------------------
// 图标：内联 SVG。路径是本文件里的静态常量，不含用户数据，因此不碰 innerHTML。
// ---------------------------------------------------------------------------

export const ICONS = {
  cases: "M5 4h14v16H5zM9 8h6M9 12h6M9 16h3",
  runs: "M5 12h3l2-6 4 12 2-6h3",
  key: "M15 9a3 3 0 1 1-3 3M12 12l-7 7M7 17l2 2M9 15l2 2",
  plus: "M12 5v14M5 12h14",
  play: "M8 5.5v13l10.5-6.5z",
  stop: "M7 7h10v10H7z",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  close: "M6 6l12 12M18 6L6 18",
  check: "M5 12.5l4.5 4.5L19 7.5",
  alert: "M12 8v5M12 16.5h.01M10.3 3.9L2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  info: "M12 11v5M12 8h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  image: "M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6",
  upload: "M12 20V9M7 14l5-5 5 5M5 4h14",
  file: "M6 3h8l4 4v14H6zM14 3v4h4",
};

export function icon(name, size = 16, className = "") {
  const NS = "http://www.w3.org/2000/svg";
  const node = document.createElementNS(NS, "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("width", String(size));
  node.setAttribute("height", String(size));
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", "1.7");
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  node.setAttribute("aria-hidden", "true");
  node.setAttribute("class", className === "" ? "icon" : `icon ${className}`);
  const shape = document.createElementNS(NS, "path");
  shape.setAttribute("d", ICONS[name] ?? "");
  node.append(shape);
  return node;
}

/** 按钮。`icon` 可选；`kind` 是 Bootstrap 的按钮档位（primary / outline-secondary / ghost …）。 */
export function button(label, { kind = "outline-secondary", size = "sm", iconName = null, title = null, onclick = null, type = "button", extra = "" } = {}) {
  const node = el("button", {
    type,
    class: `btn btn-${kind}${size === "" ? "" : ` btn-${size}`}${extra === "" ? "" : ` ${extra}`}`,
    title,
    onclick,
  });
  if (iconName !== null) node.append(icon(iconName, 15));
  if (label !== "") node.append(el("span", { class: "btn-label", text: label }));
  if (label === "" && title !== null) node.setAttribute("aria-label", title);
  return node;
}

export function download(filename, content, type = "text/yaml") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = el("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
