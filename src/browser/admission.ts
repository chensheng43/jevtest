/**
 * 用例准入：判断这个用例本平台能不能测。
 *
 * 存在的理由很实际：**假阳性是测试套件最致命的输出**。参考项目明确声明不支持
 * shadow DOM、跨域 iframe、canvas、文件上传、新标签页、嵌套滚动（见其 README
 * 「Evidence and limits」与 docs/design.md 的 Boundaries）。如果一个用例踩中这些，
 * 它会失败——但失败原因是**平台能力不足**，不是被测系统有缺陷。
 * 把这种失败和真实缺陷混在一起，整个套件的可信度就没了。
 *
 * ## 结构：采集与判定分离
 *
 *   Session.probe()  ->  AdmissionStats   （要真浏览器，不可单元测试）
 *   admit(stats, case) -> AdmissionReport （纯函数，可单元测试）
 *
 * 这样切是因为**判定规则需要能回归**——而准入规则正是假阳性的第一道防线。
 * 混在一起会让规则没法测，只能靠人肉核对；而人肉核对的规则表迟早与代码漂移。
 *
 * `admit` 是 `page: unknown` → `Session` 的替代：它不再碰浏览器，
 * 因此也不违反「`core/` 只依赖 `Session` 接口」这条可测试性原则。
 *
 * ## 定位：记录与警告，不是运行的闸
 *
 * 调用点在 `CaseAgent.run()` 第一次 `observe()` 之后，结果写进报告的
 * `admission` 字段。`blocking` 项在报告顶部显著展示，但**不阻止运行**。
 *
 * 不把它做成闸的理由：那要给 `RunStatus` 加成员（schema 变更），
 * 而准入检查要打开页面，放在入队时做会让入队变慢。要不要真做成闸留到 P1。
 */

import type { Case } from "../schema/case.ts";
import type { AdmissionReport, AdmissionStats } from "../schema/report.ts";

/** 判定为「嵌套滚动容器」的最小溢出尺寸，避免把装饰性容器算进来。 */
export const SCROLL_OVERFLOW_THRESHOLD_PX = 24;

/**
 * 准入规则表。
 *
 * **规则写成数据，而不是散在 if 里。** 因为 `docs/limitations.md` 的
 * 「用例准入清单」讲的是同一件事——两处事实来源靠人同步，必然漂移
 * （这正是 D5 想消灭的东西）。有了这张表，文档可以从它生成，
 * 测试可以逐条覆盖，新增规则也不必改动判定流程。
 *
 * 判定函数只接收 `AdmissionStats` 与用例，因此可被完整单元测试。
 */
export interface AdmissionRule {
  /** 稳定标识，出现在报告与测试里，不要随意改 */
  id: string;
  /** `blocking` 阻止用例被认为可测；`warning` 只是提示结果要打折扣 */
  severity: "blocking" | "warning";
  /** 命中即产出对应文案；返回 null 表示不命中 */
  hit(stats: AdmissionStats, caseDef: Case): string | null;
  /** 规则依据，指向 docs/limitations.md 的对应小节 */
  rationale: string;
}

/** 内置规则表。顺序不影响结果，但会影响报告里条目的排列 */
export const ADMISSION_RULES: readonly AdmissionRule[] = [
  {
    id: "canvas-only",
    severity: "blocking",
    rationale: "limitations.md §3：canvas 内部没有 DOM 节点，元素表会是空的",
    hit: (s) =>
      s.canvases > 0 && s.interactiveElements === 0
        ? `页面渲染在 ${s.canvases} 个 canvas 上，元素表里没有任何可交互元素`
        : null,
  },
  {
    id: "file-upload",
    severity: "blocking",
    rationale: "limitations.md §4：input[type=file] 不进元素表，且被内置护栏拦截",
    hit: (s) => (s.fileInputs > 0 ? `检测到 ${s.fileInputs} 个文件上传控件，本平台不支持` : null),
  },
  {
    id: "cross-origin-frames",
    severity: "warning",
    rationale: "limitations.md §2：跨域 iframe 内的 DOM 受同源策略保护，读不到",
    hit: (s) =>
      s.crossOriginFrames > 0
        ? `检测到 ${s.crossOriginFrames} 个跨域 iframe，其内部控件不可见`
        : null,
  },
  {
    id: "same-origin-frames",
    severity: "warning",
    rationale: "limitations.md §2：同源 iframe 技术可读，但当前未实现遍历",
    hit: (s) => {
      // `frames` 含主文档（见 AdmissionStats.frames），所以要减掉 1 才是同源子 frame 数。
      // **这个 1 不能省**：省掉的话任何一个没有 iframe 的页面都会命中本规则，
      // 准入检查会退化成对每一页都报一条「检测到 1 个同源 iframe」的噪声——
      // 而假阳性正是这个模块存在的理由。
      // Math.max 兜住「frame 枚举失败」的 0：那时 frames - crossOrigin 可能算出 -1，
      // 不兜的话消息里会出现「检测到 -1 个同源 iframe」。
      const sameOrigin = Math.max(0, s.frames - s.crossOriginFrames - 1);
      return sameOrigin > 0 ? `检测到 ${sameOrigin} 个同源 iframe，当前只遍历主文档` : null;
    },
  },
  {
    id: "shadow-roots",
    severity: "warning",
    rationale: "limitations.md §1：不递归 shadowRoot，其内部控件不进元素表",
    hit: (s) =>
      s.shadowRoots > 0
        ? `检测到 ${s.shadowRoots} 个 shadow root，其内部控件不可见（P1 计划支持递归）`
        : null,
  },
  {
    id: "nested-scroll",
    severity: "warning",
    rationale: "limitations.md §6：只处理文档级滚动，内部容器滚不到",
    hit: (s) =>
      s.nestedScrollContainers > 0
        ? `检测到 ${s.nestedScrollContainers} 个嵌套滚动容器，目标内容可能滚不到`
        : null,
  },
  {
    id: "password-fields",
    severity: "warning",
    rationale: "limitations.md §4：密码框被内置护栏拦截，需要登录的用例会卡住",
    hit: (s) =>
      s.passwordFields > 0 ? `检测到 ${s.passwordFields} 个密码框，护栏会拦截对它们的输入` : null,
  },
];

/**
 * 纯函数判定：从探测统计与用例算出准入结论。
 *
 * 不碰浏览器、不调用模型，因此可以拿构造的 stats 直接单元测试每一条规则。
 */
export function admit(stats: AdmissionStats, caseDef: Case): AdmissionReport {
  const blocking: string[] = [];
  const warnings: string[] = [];

  for (const rule of ADMISSION_RULES) {
    let message: string | null;
    try {
      message = rule.hit(stats, caseDef);
    } catch (error) {
      // 一条规则写错不该让整个运行失败——准入的定位是「记录与警告，不是闸」
      // （见文件头）。规则本身有 tests/admission.test.ts 逐条守着。
      message = `准入规则 ${rule.id} 判定失败：${error instanceof Error ? error.message : String(error)}`;
    }
    if (message === null) continue;
    if (rule.severity === "blocking") blocking.push(message);
    else warnings.push(message);
  }

  return { ok: blocking.length === 0, blocking, warnings, stats };
}

/**
 * 把准入结论转成给人看的一句话清单。
 *
 * blocking 与 warning 的语气必须明显不同：前者是「这个用例不该跑」，
 * 后者是「跑得动，但结果可能不准，原因如下」。
 *
 * 语气差别不是修辞——**blocking 的失败会被误读成被测系统的缺陷**，
 * 而它其实是平台能力不足（假阳性，见 docs/limitations.md 开头）。
 * 清单要让读的人第一眼就把这两类分开。
 */
export function describeAdmission(report: AdmissionReport): string[] {
  const lines: string[] = [];

  if (report.ok) {
    lines.push("准入结论：可以测。未发现本平台能力之外的特征。");
  } else {
    lines.push(
      `准入结论：不该跑（${report.blocking.length} 项阻断）。` +
        "命中项属于平台能力不足，不是被测系统的缺陷——不要把它当成本次运行发现的卡点。",
    );
  }

  for (const reason of report.blocking) lines.push(`  阻断 · ${reason}`);
  for (const reason of report.warnings) lines.push(`  警告 · ${reason}`);

  if (report.warnings.length > 0) {
    lines.push("  以上警告不阻止运行，但结论要打折扣地看：命中的区域可能读不到、读不全或滚不到。");
  }

  const s = report.stats;
  lines.push(
    // frame 数按**含主文档**的口径打印（见 AdmissionStats.frames），
    // 并显式点出这一点：不然「1 个 frame」会被读成「只有 1 个 iframe」。
    `  探测统计：frame ${s.frames}（含主文档，其中跨域 ${s.crossOriginFrames}）· shadow root ${s.shadowRoots}` +
      ` · canvas ${s.canvases} · 密码框 ${s.passwordFields} · 文件上传 ${s.fileInputs}` +
      ` · 嵌套滚动容器 ${s.nestedScrollContainers} · 可交互元素 ${s.interactiveElements}`,
  );

  return lines;
}

// TODO(P1): 让 docs/limitations.md 的准入清单从 ADMISSION_RULES 生成，
//           消除两处事实来源（见 docs/architecture.md §11.2）。
//           现在这两处已经开始漂移了：limitations.md §2 写的是「frames > 1」，
//           而规则算的是 frames - crossOriginFrames - 1 > 0——意思一样，
//           但读的人得自己在脑子里换算一次。
