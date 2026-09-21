/**
 * 夹具站点的页面脚本。
 *
 * 刻意不引入任何框架、不发起任何网络请求：这个站点只服务于离线 e2e，
 * 依赖越少越不会自己坏掉。
 *
 * 它负责四件事：
 *   1. 提交搜索后**异步**渲染结果卡片（验证动态内容出现后的观测）；
 *   2. 自动补全候选**异步**渲染（验证 settle 的 combobox 模式）；
 *   3. 三个陷阱元素的定时器（验证执行前的几何重解析与命中测试）；
 *   4. 把一份状态挂在 `window.__fixture` 上——**这是 e2e 断言的物证**：
 *      「护栏把动作拦下来了」不能只看 status，还要确认页面上的处理器根本没跑。
 */
(() => {
  "use strict";

  /**
   * 自动补全候选的渲染延迟。
   *
   * 这里**可以**用一个毫秒数，因为 combobox 模式的 settle
   * 会一直轮询到有可见 option 出现为止，上限 `SETTLE_MS.combobox`（200ms）。
   * 它存在的意义就是别让模型看到一个空候选集（见 playwright-session.ts 的 settleCombobox）。
   */
  const OPTIONS_DELAY_MS = 60;

  const DEFAULT_TRAP_DELAY_MS = 800;

  /** 夹具数据。数量少而稳定，便于断言时引用具体标签。 */
  const DEVICES = [
    { id: "1", name: "HP LaserJet 1020", category: "printer", categoryLabel: "打印机", status: "在线", location: "三楼机房" },
    { id: "2", name: "Canon iR-ADV C3530", category: "printer", categoryLabel: "打印机", status: "离线", location: "二楼前台" },
    { id: "3", name: "TP-Link ER605", category: "router", categoryLabel: "路由器", status: "在线", location: "一楼弱电间" },
    { id: "4", name: "Huawei AR6121", category: "router", categoryLabel: "路由器", status: "在线", location: "三楼机房" },
  ];

  const MODELS = ["HP LaserJet 1020", "HP LaserJet M404", "Canon iR-ADV C3530", "TP-Link ER605", "Huawei AR6121"];

  /**
   * 陷阱元素的生效延迟。
   *
   * **必须留出一个观测窗口。** 立刻生效的话，元素在**观测时**就已经不可用了，
   * 于是 snapshot.js 根本不会把它放进元素表——测到的变成「它本来就不该被选中」，
   * 而不是我们真正要验证的那件事：「决策做出之后它变了，所以这一步不能执行」。
   *
   * 可以用 `?trapDelay=<ms>` 覆写，例如 `index.html?trapDelay=5000`。
   * 注意这个默认值**被 tests/e2e/fixture.e2e.test.ts 引用**（那边的 `TRAP_DELAY_MS`），
   * 改它要同步改那边——820ms 那种级别的差异不会报错，只会让
   * 「观测后移出视口」那条用例变成一次静默的通过。
   *
   * **不能写成 `Number(params.get("trapDelay"))`。** 参数缺席时 `get()` 返回 `null`，
   * 而 `Number(null)` 是 **0** 不是 NaN——于是「没传参数」会被当成「延迟 0ms」，
   * 陷阱在页面加载的那一刻就生效，观测窗口直接消失。
   * 那种错不会报任何异常，只会让「观测时可见」这条前提悄悄不成立。
   */
  const rawTrapDelay = new URLSearchParams(location.search).get("trapDelay");
  const queriedDelay = rawTrapDelay === null || rawTrapDelay.trim() === ""
    ? Number.NaN
    : Number(rawTrapDelay);
  const TRAP_DELAY_MS = Number.isFinite(queriedDelay) && queriedDelay >= 0
    ? queriedDelay
    : DEFAULT_TRAP_DELAY_MS;

  /**
   * 供测试读取的状态。
   *
   * 放在 window 上而不是藏进闭包：e2e 断言需要用 `page.evaluate` 读到它，
   * 才能证明「某个处理器到底有没有跑」。
   */
  window.__fixture = {
    deleted: false,
    searched: false,
    navigated: 0,
    trapClicked: null,
    trapMoved: false,
    trapDisabled: false,
    trapDelayMs: TRAP_DELAY_MS,
  };

  const $ = (id) => document.getElementById(id);

  // -------------------------------------------------------------------------
  // 搜索
  // -------------------------------------------------------------------------

  const form = $("search-form");
  const results = $("results");
  const status = $("search-status");

  function matches(device, query, category, onlyOnline) {
    if (category !== "all" && device.category !== category) return false;
    if (onlyOnline && device.status !== "在线") return false;
    if (query === "") return true;
    return (device.name + device.categoryLabel + device.location).includes(query);
  }

  /**
   * 卡片的排版：文字块与按钮左右分列。
   *
   * 不只是好看——卡片必须**矮**。视口只有 780px 高，卡片一高，
   * 最下面那张的「查看详情」按钮就会落到首屏之外，于是它根本不进元素表。
   */
  function cardOf(device) {
    const card = document.createElement("article");
    card.className = "card";
    card.dataset.id = device.id;

    const text = document.createElement("div");
    text.className = "card-text";

    const title = document.createElement("h3");
    title.textContent = device.name;

    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = `分类：${device.categoryLabel} · 状态：${device.status} · 位置：${device.location}`;

    // 所有卡片的按钮标签都是「查看详情」——**刻意如此**：
    // 真实站点里同名控件很常见，而平台只能按语义标签定位（没有选择器可用），
    // 夹具因此也要把它当成常态来覆盖。
    const detail = document.createElement("button");
    detail.className = "detail";
    detail.textContent = "查看详情";
    detail.addEventListener("click", () => {
      window.__fixture.navigated += 1;
      // 同标签页导航：换文档，window.__jev 的节点身份缓存随之重置
      location.href = `detail.html?id=${encodeURIComponent(device.id)}`;
    });

    text.append(title, meta);
    card.append(text, detail);
    return card;
  }

  function renderResults(list) {
    results.replaceChildren();
    if (list.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = "没有匹配的设备。";
      results.append(empty);
    }
    for (const device of list) results.append(cardOf(device));
    status.textContent = `找到 ${list.length} 台设备。`;
  }

  form.addEventListener("submit", (event) => {
    // 拦截默认提交：页面一旦真的跳转，刚刚渲染的卡片立刻就作废了
    event.preventDefault();
    const query = $("q").value.trim();
    const category = $("category").value;
    const onlyOnline = $("only-online").checked;

    Object.assign(window.__fixture, {
      searched: true,
      lastQuery: query,
      lastCategory: category,
      lastOnlyOnline: onlyOnline,
    });

    status.textContent = "正在搜索……";
    results.replaceChildren();
    // **下一个动画帧**，不是 setTimeout。
    //
    // 这里踩过一次：`setTimeout(..., 20)` 会输给 settle。
    // `settleDocument` 等的是**两个 rAF**（`SETTLE_MS` 只是兜底上限，不是等待时长），
    // 而 headless 下两个 rAF 只要几毫秒——20ms 的定时器还没到点，
    // 动作之后的那次 observe 已经把空结果读走了，表现为「卡片明明渲染了却不在元素表里」。
    //
    // rAF 则是在 settle 的 rAF **之前**注册的，因此必然先于它执行，
    // 渲染一定落在同一次观测里。它仍然是真的异步（不在 submit 处理器里同步渲染），
    // 只是把时机对齐到帧，而不是赌一个与 settle 赛跑的毫秒数。
    requestAnimationFrame(() => renderResults(DEVICES.filter((d) => matches(d, query, category, onlyOnline))));
  });

  form.addEventListener("reset", () => {
    status.textContent = "";
    results.replaceChildren();
  });

  // -------------------------------------------------------------------------
  // 自动补全（可编辑 combobox）
  // -------------------------------------------------------------------------

  const picker = $("model-picker");
  const options = $("picker-options");

  picker.addEventListener("input", () => {
    const query = picker.value.trim();
    options.replaceChildren();
    picker.setAttribute("aria-expanded", "false");
    if (query === "") return;
    setTimeout(() => {
      for (const model of MODELS.filter((m) => m.toLowerCase().includes(query.toLowerCase()))) {
        const item = document.createElement("li");
        item.setAttribute("role", "option");
        item.dataset.value = model;
        item.textContent = model;
        item.addEventListener("click", () => {
          picker.value = model;
          options.replaceChildren();
          picker.setAttribute("aria-expanded", "false");
        });
        options.append(item);
      }
      picker.setAttribute("aria-expanded", String(options.children.length > 0));
    }, OPTIONS_DELAY_MS);
  });

  // -------------------------------------------------------------------------
  // 危险操作
  // -------------------------------------------------------------------------

  $("delete-project").addEventListener("click", () => {
    window.__fixture.deleted = true;
    $("delete-result").textContent = "已删除（夹具不做任何真实操作，这里只是留个痕迹）";
  });

  // -------------------------------------------------------------------------
  // 陷阱元素
  // -------------------------------------------------------------------------

  const traps = ["trap-mover", "trap-disable-later", "trap-occluded", "trap-offscreen"];
  for (const id of traps) {
    $(id).addEventListener("click", () => {
      window.__fixture.trapClicked = id;
    });
  }

  setTimeout(() => {
    // 用 transform 而不是改 top：它会改变 getBoundingClientRect，
    // 而那正是执行前那次几何重解析读的东西（resolveTargetInPage）
    $("trap-mover").style.transform = "translateY(-4000px)";
    window.__fixture.trapMoved = true;
  }, TRAP_DELAY_MS);

  setTimeout(() => {
    $("trap-disable-later").disabled = true;
    window.__fixture.trapDisabled = true;
  }, TRAP_DELAY_MS);
})();
