/**
 * 原子 DOM 快照。
 *
 * 移植自 jev-ultrafast 的 jev_ultrafast/snapshot.js
 * (https://github.com/browser-use/jev-ultrafast, MIT License, Copyright (c) 2026 Browser Use)
 * 详见 NOTICE。
 *
 * 相对原版只有七处改动：
 *   1. 全局缓存名 `window.__jevFast` -> `window.__jev`。
 *   2. 本文件头（原文无）。
 *   3. 候选集收集时加一次 `elementFromPoint` 命中测试（行内标了 `jevtest:`）。
 *      上游只在输入前测遮挡，于是被盖住的元素照样进候选集；模型选中它、输入前被拦下、
 *      重新观测后它还在、模型再选它——一次真跑在弹窗里一个被滚动区裁掉的复选框上
 *      这样空转了 16 次模型调用。
 *   4. 语义候选之后追加一轮 `cursor:pointer` 候选（行内标了 `jevtest:`）：
 *      没有 role 的 `<li>` / `<div>` 靠事件委托可点，上游看不见它们。
 *   5. 额外返回 `notices`：当前可见的页面提示（toast / alert / 表单校验，行内标了 `jevtest:`）。
 *      不进 marker——它的文字本来就在 text 里，新鲜度与指纹不因它另起一套判据。
 *   6. 名字认不出是哪一个的候选（名字为空 / 只是 placeholder / 与同角色的候选重名），
 *      label 补上它所在那一组的文字，在表格行里再带上第几行（行内标了 `jevtest:`）。
 *      上游只用可访问名：每行的复选框都叫 `checkbox`、满屏输入框都叫「请输入」，模型分不开。
 *   7. 同源 iframe（行内标了 `jevtest:`）：本脚本在每个同源 frame 里各跑一次，
 *      子 frame 里的候选几何换算到**顶层视口**坐标，命中测试逐层做到顶层；额外返回 `frame`。
 *      主文档里这些都是恒等变换，行为与上游一致。拼装各 frame 的结果是 playwright-session.ts 的事。
 * 其余逐字保留——包括变量命名风格，**这是刻意的**：
 * 上游若修复了可访问名解析或守卫语义，我们能直接 diff 而不必重新推导。
 *
 * 因此本文件的返回结构保持原版的 snake_case（`page_key` / `omitted_actions`），
 * 到 TypeScript `Observation` 的字段映射由 playwright-session.ts 负责。
 *
 * 它以**文本**读出后注入 page.evaluate，从不作为模块 import——
 * 所以它保持 .js 扩展名，并靠 scripts/copy-assets.mjs 进 dist/。
 *
 * 三条核心机制（决定了整个 agent 的行为）：
 *
 *   1. **code-owned 节点身份**。WeakMap 给每个 DOM 节点分配一个整数 id，
 *      模型只能回传这个 id，永远看不到也写不出 CSS 选择器。
 *      节点被替换会拿到新身份，导航会重置缓存——这就是「陈旧」的定义。
 *
 *   2. **只暴露可见、可点、在视口内、未被遮挡的元素**。`checkVisibility` 加几何判断
 *      加中心点命中测试，离屏或被盖住的元素直接不进候选集，模型不会浪费时间点一个点不到的东西。
 *      命中测试与输入前那次（playwright-session.ts 的 resolveTargetInPage）是**同一条标准**：
 *      这里排除的元素，输入前也一定会被拦下（除非页面在两者之间变了）。
 *
 *   3. **语义守卫**。`pageKey` 记录文档级状态（timeOrigin/href/滚动/视口/表单值），
 *      `guard` 记录单个元素的身份、可访问名、值与附近上下文文本。
 *      执行前比较它们，就能判断「这次决策还有效吗」，而不必去数 DOM 变更次数
 *      （参考项目正是靠这个把每步的浏览器协议调用从 1092 次降到 101 次）。
 *
 * 已知边界（与上游一致，见 docs/limitations.md）：
 *   - 不递归 shadow root        （P1 计划支持，约 10 行）
 *   - 只跨同源 iframe           （跨域 frame 读不到；id 的 `f1:e7` 限定由 playwright-session.ts 加）
 *   - 不处理 canvas / 文件上传 / 新标签页 / 嵌套滚动容器
 */
(() => {
  if (!document.body) return null;
  const cache = window.__jev ||= {ids:new WeakMap(), nodes:new Map(), next:1};
  const identity = e => {
    if (!cache.ids.has(e)) cache.ids.set(e,cache.next++);
    const id=cache.ids.get(e); cache.nodes.set(id,e); return id;
  };
  for (const [id,e] of cache.nodes) if (!e.isConnected) cache.nodes.delete(id);
  const safe = e => !['password','file','hidden'].includes(e.type);
  const visible = e => !e.closest('[aria-hidden="true"],[inert]') &&
    e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  // jevtest: 同源 iframe。一次真跑里「添加产品」的表单整个在弹窗的 iframe 里，主文档又被弹窗遮罩盖住，
  // 模型面前只剩空壳，只能回 BLOCKED。输入发在顶层页面上，所以子 frame 的候选必须在顶层点得到：
  // chain 从本 frame 往上记每一层的 <iframe> 与它的内容区原点（累计到顶层的偏移）。
  // reachable 逐层要求父文档在该点命中的正是这个 <iframe>——被父文档的遮罩或别的浮层盖住同样点不到。
  // 主文档里 window===parent，chain 为空：reachable 恒真、偏移为 0，与上游逐字等价。
  // 祖先跨域（frameElement 为 null）或 <iframe> 本身不可见时换算不了，整个 frame 按读不到处理。
  const chain=[]; let dx=0, dy=0;
  for (let w=window; w!==w.parent; w=w.parent) {
    const f=w.frameElement;
    if (!f || !visible(f)) return null;
    const r=f.getBoundingClientRect(), s=w.parent.getComputedStyle(f);
    dx+=r.x+f.clientLeft+parseFloat(s.paddingLeft); dy+=r.y+f.clientTop+parseFloat(s.paddingTop);
    chain.push({f,win:w.parent,dx,dy});
  }
  const reachable = (x,y) => chain.every(({f,win,dx:ox,dy:oy}) => {
    const px=x+ox, py=y+oy;
    return px>=0 && py>=0 && px<win.innerWidth && py<win.innerHeight && win.document.elementFromPoint(px,py)===f;
  });
  // jevtest: SELECT / TEXTAREA 与 INPUT 一样不从内容取名（它们的内容是选项与取值，不是名字）。
  // 上游只排除了 INPUT：一次真跑里分类选择器的 <select> 没有 label，名字退成了全部选项拼起来
  // 的两千多字，每个选项的 SELECT 候选都带着它，决策请求被服务端以 max_tokens_exceeded 拒绝。
  const name = (e,seen=new Set()) => {
    if (!e || seen.has(e)) return '';
    seen.add(e);
    const referenced=(e.getAttribute('aria-labelledby')||'').split(/\s+/)
      .map(id=>name(document.getElementById(id),seen)).filter(Boolean).join(' ');
    return referenced || e.getAttribute('aria-label') ||
      [...(e.labels||[])].map(l=>name(l,seen)).filter(Boolean).join(' ') ||
      (['button','submit','reset'].includes(e.type) ? e.value : '') || e.getAttribute('alt') ||
      (['INPUT','SELECT','TEXTAREA'].includes(e.tagName) ? '' : [...e.childNodes].map(n=>n.nodeType===3 ? n.textContent :
        n.nodeType===1 && n.getAttribute('aria-hidden')!=='true' ? name(n,seen) : '').join(' ').trim()) ||
      e.getAttribute('title') || e.getAttribute('placeholder') || '';
  };
  const roles=['button','link','checkbox','radio','switch','tab','menuitem','menuitemradio',
    'option','gridcell','combobox','textbox','searchbox','spinbutton'];
  const selector='a[href],button,input,textarea,select,summary,[contenteditable="true"],'+
    roles.map(role=>'[role="'+role+'"]').join(',');
  const role = e => {
    const explicit=e.getAttribute('role');
    if (roles.includes(explicit)) return explicit;
    if (e.tagName==='BUTTON' || e.tagName==='SUMMARY') return 'button';
    if (e.tagName==='A') return 'link';
    if (e.tagName==='SELECT') return 'combobox';
    if (e.tagName==='TEXTAREA' || e.isContentEditable) return 'textbox';
    if (e.tagName==='INPUT') {
      if (['checkbox','radio'].includes(e.type)) return e.type;
      if (['button','submit','reset','image'].includes(e.type)) return 'button';
      if (e.type==='search') return 'searchbox';
      if (e.type==='number') return 'spinbutton';
      if (['text','email','url','tel'].includes(e.type)) return 'textbox';
    }
    return null;
  };
  // jevtest: 候选自己的名字认不出是哪一个时，label 补上它所在的那一组。两种情况：
  //   - 名字弱：空的（上游回退到角色名，每行的复选框都叫 `checkbox`）或只是 placeholder
  //     （提示语不是标签，满屏都叫「请输入」）；
  //   - 名字撞车：同一角色下不止一个候选叫这个名字（一列「编辑」、几组「是 / 否」）。
  // 「那一组」是从候选往上、不含与它混淆的候选的最大祖先——名字弱时同角色的都算混淆，
  // 撞车时同角色同名的才算。它的文字就是表单项标签、表格行、卡片标题；在表格行里再带上第几行。
  // 真跑里的两次事故都是这一类：表头全选框与数据行的复选框同名，模型第一步点了全选；
  // 「库存SKU:」没用 for= 关联，输入框只叫「请输入」，文本模型不知道填什么，回了 text: null。
  // 只改发给模型的 label；guard 仍用 name(e)，新鲜度判据不变。
  const clean = value => (value||'').replace(/\s+/g,' ').trim();
  const rowPosition = e => {
    const row=e.closest('tr,[role="row"]');
    if (!row) return '';
    if (row.closest('thead') || (row.querySelector('th,[role="columnheader"]') &&
      !row.querySelector('td,[role="cell"],[role="gridcell"]'))) return 'header row';
    let index=1;
    for (let p=row.previousElementSibling; p; p=p.previousElementSibling)
      if (p.matches('tr,[role="row"]') && !p.querySelector('th,[role="columnheader"]')) index++;
    return 'row '+index;
  };
  const describe = picked => {
    const within=new Map(), total=new Map(), labels=new Map();
    const bump = (map,key) => map.set(key,(map.get(key)||0)+1);
    const keyOf = ({e,rname,own}) => !own || own===e.getAttribute('placeholder') ? rname : rname+'\n'+own;
    for (const {e,rname,own} of picked) {
      bump(total,rname+'\n'+own);
      for (let p=e.parentElement; p; p=p.parentElement) {
        if (!within.has(p)) within.set(p,new Map());
        bump(within.get(p),rname); bump(within.get(p),rname+'\n'+own);
      }
    }
    for (const item of picked) {
      const {e,rname,own}=item, key=keyOf(item);
      if (key!==rname && total.get(key)===1) { labels.set(e,own); continue; }
      // 文字超过 80 字多半已经爬出了这一组，停在上一层——除非上一层一个字都没有，那就截前 80 字
      let text='';
      // 下拉自己的选项不算组文字：名字空的 <select> 往上爬，第一层读到的就是它全部的选项
      const inner=e.tagName==='SELECT' ? clean(e.innerText) : '';
      for (let p=e.parentElement; p && p!==document.body && within.get(p).get(key)===1; p=p.parentElement) {
        const value=clean(inner ? clean(p.innerText).replace(inner,' ') : p.innerText);
        if (value.length>80) { text ||= value.slice(0,80); break; }
        text=value;
      }
      labels.set(e,[own||rname,rowPosition(e),text!==own ? text : ''].filter(Boolean).join(' · '));
    }
    return labels;
  };
  cache.pageKey=()=>[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    [...document.querySelectorAll('input,textarea,select')].filter(safe)
      .map(e=>[identity(e),e.value,e.checked,e.selectedIndex,e.disabled,e.readOnly])];
  cache.guard=e=>{
    if (!e?.isConnected || !visible(e)) return null;
    const scope=e.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') || e.parentElement;
    return [identity(e),role(e),name(e),e.value??null,e.checked??null,e.selectedIndex??null,
      e.readOnly??null,e.matches(':disabled'),e.getAttribute('aria-disabled'),
      e.getAttribute('aria-expanded'),e.getAttribute('aria-checked'),e.getAttribute('aria-selected'),
      e.getAttribute('href'),scope?.innerText?.slice(0,6000)||''];
  };
  const picked=[];
  for (const e of document.querySelectorAll(selector)) {
    if (!safe(e) || !visible(e) || e.matches(':disabled') || e.closest('[aria-disabled="true"]')) continue;
    const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2, rname=role(e);
    if (!rname || r.width<=0 || r.height<=0 || x<0 || y<0 || x>=innerWidth || y>=innerHeight) continue;
    // jevtest: 中心点被盖住（浮层、弹窗底栏、滚动容器裁掉）就点不到，不进候选集
    const hit=document.elementFromPoint(x,y);
    if (!hit || (hit!==e && !e.contains(hit)) || !reachable(x,y)) continue;
    if (rname==='gridcell' && e.querySelector('button,[role="button"]')) continue;
    picked.push({e,r,rname,own:name(e)});
  }
  // jevtest: 没有语义、只靠 cursor:pointer + 事件委托才可点的元素（jQuery/Bootstrap 时代的
  // 下拉菜单 <li>、div 按钮）。上游的 selector 认不出它们：一次真跑里下拉菜单已经展开，
  // 模型读得到「导入eBay产品库」却没有 id 可点，只好去点侧边栏里名字最像的「eBay 导入」链接。
  // 只收最外层的 pointer 元素（子孙继承 cursor，不重复收），且与已有候选不重叠
  // （包住候选的 <label>/卡片、候选内部的 <span> 都跳过）。追加在末尾，250 裁剪时先裁它们。
  // role 记 button：它可能触发任何命令，只读模式按 button 剔除是保守的一侧。
  const taken=new Set(picked.map(item=>item.e)), covering=new Set();
  for (const e of taken) for (let p=e.parentElement; p && !covering.has(p); p=p.parentElement) covering.add(p);
  const pointer = e => !!e && getComputedStyle(e).cursor==='pointer';
  for (const e of document.body.querySelectorAll('*')) {
    if (taken.has(e) || covering.has(e)) continue;
    const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
    if (r.width<=0 || r.height<=0 || x<0 || y<0 || x>=innerWidth || y>=innerHeight) continue;
    if (!pointer(e) || pointer(e.parentElement)) continue;
    let inside=false;
    for (let p=e.parentElement; p && !inside; p=p.parentElement) inside=taken.has(p);
    if (inside || !visible(e) || e.closest('[aria-disabled="true"]')) continue;
    const hit=document.elementFromPoint(x,y);
    if (!hit || (hit!==e && !e.contains(hit)) || !reachable(x,y)) continue;
    const own=name(e).replace(/\s+/g,' ').trim().slice(0,120);
    if (!own) continue;
    picked.push({e,r,rname:'button',own,pointer:true});
  }
  const labels=describe(picked), actions=[];
  for (const {e,r,rname,pointer} of picked) {
    const base={node:identity(e),role:rname,label:labels.get(e),
      rect:{x:r.x+dx,y:r.y+dy,w:r.width,h:r.height}};
    if (pointer) { actions.push({...base,kind:'click',value:''}); continue; }
    for (const key of ['checked','selected','expanded']) {
      const value=e.getAttribute('aria-'+key);
      if (value!==null) base[key]=value;
    }
    if (['checkbox','radio'].includes(e.type)) base.checked=String(e.checked);
    if (e.tagName==='SELECT') {
      for (const o of e.options) if (!o.selected && !o.disabled && !o.closest('optgroup[disabled]'))
        actions.push({...base,kind:'select',value:o.value,
          current_value:[...e.selectedOptions].map(o=>o.label).join(', '),label:base.label+' → '+o.label});
    } else {
      const editable=!e.readOnly && e.getAttribute('aria-readonly')!=='true' &&
        (['textbox','searchbox','spinbutton'].includes(rname) ||
          (rname==='combobox' && ['INPUT','TEXTAREA'].includes(e.tagName)));
      const value='value' in e ? String(e.value) :
        e.isContentEditable || rname==='combobox' ? e.innerText.trim() : '';
      actions.push({...base,kind:editable?'fill':'click',value});
      if (editable) actions.push({...base,kind:'click',value,label:'Open '+base.label});
    }
  }
  const words=[], walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  const range=document.createRange(); let node,length=0;
  while ((node=walker.nextNode()) && length<6000) {
    const value=node.textContent.trim(), parent=node.parentElement;
    if (!value || !parent || parent.closest('script,style,noscript,template') || !visible(parent)) continue;
    range.selectNodeContents(node); const r=range.getBoundingClientRect();
    if (r.width>0 && r.height>0 && r.bottom>0 && r.top<innerHeight && r.right>0 && r.left<innerWidth) {
      words.push(value); length+=value.length;
    }
  }
  // jevtest: 页面提示（toast、全局报错、表单校验）。它们也在上面的 text 里，但混在几千字当中、
  // 与同名的占位符分不开：一次真跑里「请输入SKU」的 toast 弹了四次，模型次次仍点「确定」。
  // 单独收出来给模型置顶。两类来源：
  //   - 语义提示：role=alert/status、aria-live。只要求可见且有尺寸（读屏专用的 1px 区域不收）；
  //   - 自造浮层：id/class 像提示、自身 fixed/absolute 定位、不是整宽横幅（整宽的多半是
  //     常驻公告，每步都报只是噪音）。命中的实例是 `<div id="msg-mini" class="msgno">`。
  // 只收最外层；过长的（>200 字）不是提示而是内容区，不收。
  const notices=[], noticeTaken=[];
  const noticeName=/toast|message|msg|notif|alert|snackbar/i;
  for (const e of document.body.querySelectorAll('*')) {
    if (noticeTaken.some(t=>t.contains(e))) continue;
    const semantic=['alert','status'].includes(e.getAttribute('role')) ||
      ['assertive','polite'].includes(e.getAttribute('aria-live'));
    if (!semantic && !noticeName.test(e.id+' '+(typeof e.className==='string' ? e.className : ''))) continue;
    if (!visible(e)) continue;
    const r=e.getBoundingClientRect();
    if (r.width<4 || r.height<4 || r.bottom<=0 || r.top>=innerHeight || r.right<=0 || r.left>=innerWidth) continue;
    if (!semantic && (!['fixed','absolute'].includes(getComputedStyle(e).position) || r.width>=innerWidth*0.9)) continue;
    const value=(e.innerText||'').replace(/\s+/g,' ').trim();
    if (!value || value.length>200) continue;
    noticeTaken.push(e);
    if (!notices.includes(value)) notices.push(value);
    if (notices.length>=5) break;
  }
  const text=words.join('\n').slice(0,6000), height=document.documentElement.scrollHeight;
  const page_key=cache.pageKey(), guards={};
  for (const a of actions) if (!(a.node in guards)) guards[a.node]=cache.guard(cache.nodes.get(a.node));
  // Compare meaning and identity. Geometry is always resolved and hit-tested just before input.
  const semantics=actions.map(({rect,...action})=>action);
  const marker=[performance.timeOrigin,location.href,scrollX,scrollY,innerWidth,innerHeight,
    document.title,text,semantics,page_key[6]];
  const omitted_actions=Math.max(0,actions.length-250);
  actions.splice(250);
  actions.forEach((a,i)=>a.id='e'+(i+1));
  if (scrollY+innerHeight<height-2) actions.push({id:'scroll_down',kind:'scroll',label:'Scroll down',delta:560});
  if (scrollY>0) actions.push({id:'scroll_up',kind:'scroll',label:'Scroll up',delta:-560});
  actions.push({id:'wait',kind:'wait',label:'Wait for the page to update'});
  // jevtest: 子 frame 的视口在顶层里的位置（主文档为 null），拼装时据此判断滚轮落在哪个 frame 上
  const frame=chain.length ? {x:dx,y:dy,w:innerWidth,h:innerHeight} : null;
  return {url:location.href,title:document.title,w:innerWidth,h:innerHeight,text,
    scroll:{y:scrollY,height},actions,marker,page_key,guards,omitted_actions,notices,frame};
})()
