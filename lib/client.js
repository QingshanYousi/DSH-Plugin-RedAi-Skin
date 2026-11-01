/**
 * Redai 皮肤 — 浏览器半侧
 *
 * 现状：W2（壁纸型 MVP）
 *   1) 用官方 ctx.theme.overrideTokens(source, tokens) 把面板底色改成半透明
 *      —— 必须是 { light, dark } 成对字符串，否则官方直接抛 TypeError
 *   2) 注入 <style> 给 body 铺壁纸（CSS 渐变，零素材、零权限）
 *   3) 换肤返回 disposer，插件卸载即还原
 *
 * 还没有设置页（P2 再做）。临时用控制台切换：
 *   __redaiSkin.list()           列出可用皮肤
 *   __redaiSkin.set('aurora')    立即切换（无需重启）
 *   __redaiSkin.set('none')      关闭壁纸
 */
window.__ModuleLoader__.load({
  id: "dsh-plugin-redai-skin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    const LOG = "[redai-skin]";
    const STYLE_ID = "redai-skin-style";
    const SOURCE = "redai-skin";
    const KEY = "redai.skin.current";

    /* ---------------- 官方底色（P0 导出值）作为半透明的基色 ---------------- */
    const BASE = {
      light: {
        base: [255, 255, 255],
        layer1: [255, 255, 255],
        layer2: [255, 255, 255],
        layer3: [255, 255, 255],
        sidebar: [249, 250, 251],
      },
      dark: {
        base: [21, 21, 23],
        layer1: [35, 35, 36],
        layer2: [44, 44, 46],
        layer3: [53, 54, 56],
        sidebar: [27, 27, 28],
      },
    };

    const TOKEN_MAP = [
      ["--dsw-alias-bg-base", "base"],
      ["--dsw-alias-bg-layer-1", "layer1"],
      ["--dsw-alias-bg-layer-2", "layer2"],
      ["--dsw-alias-bg-layer-3", "layer3"],
      ["--dsw-specific-sidebar-fill", "sidebar"],
    ];

    /* ---------- 颜色工具（支持 #rgb / #rrggbb / #rrggbbaa） ---------- */
    function parseHex(h) {
      if (!h || h[0] !== "#") return null;
      let x = h.slice(1);
      if (x.length === 3) x = x.split("").map(function (c) { return c + c; }).join("");
      if (x.length !== 6 && x.length !== 8) return null;
      return [parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16),
              parseInt(x.slice(4, 6), 16), x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1];
    }
    function toRgba(rgb, a) {
      return "rgba(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + "," + (a == null ? rgb[3] : a) + ")";
    }
    function alphaOf(hex, a) {
      const c = parseHex(hex);
      return c ? toRgba(c, a) : hex;
    }
    /** ratio > 0 向白/黑偏移；用于 hover 或加深 */
    function shade(hex, ratio) {
      const c = parseHex(hex);
      if (!c) return hex;
      const t = ratio > 0 ? 255 : 0;
      const k = Math.abs(ratio);
      return toRgba([
        Math.round(c[0] + (t - c[0]) * k),
        Math.round(c[1] + (t - c[1]) * k),
        Math.round(c[2] + (t - c[2]) * k),
        1,
      ]);
    }
    /** 把 a 混进 b 的比例（0~1），保留 b 的亮度骨架 */
    function mix(baseHex, tintHex, k) {
      const b = parseHex(baseHex);
      const t = parseHex(tintHex);
      if (!b || !t) return baseHex;
      return toRgba([
        Math.round(b[0] + (t[0] - b[0]) * k),
        Math.round(b[1] + (t[1] - b[1]) * k),
        Math.round(b[2] + (t[2] - b[2]) * k),
        1,
      ]);
    }

    function rgba(rgb, a) {
      return "rgba(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + "," + a + ")";
    }

    /* ---------------- 通透度档位（W3：分区 alpha） ----------------
     * veil    : 应用底色（越小壁纸越透）
     * layer   : 面板/卡片（消息区、弹层）
     * sidebar : 侧栏（比面板更透，形成层次）
     */
    const TONES = [
      { id: "soft",   name: "柔和", light: { veil: 0.34, layer: 0.88, sidebar: 0.66 },
                                   dark:  { veil: 0.40, layer: 0.90, sidebar: 0.70 } },
      { id: "normal", name: "标准", light: { veil: 0.18, layer: 0.80, sidebar: 0.52 },
                                   dark:  { veil: 0.26, layer: 0.84, sidebar: 0.58 } },
      { id: "clear",  name: "通透", light: { veil: 0.06, layer: 0.71, sidebar: 0.38 },
                                   dark:  { veil: 0.12, layer: 0.76, sidebar: 0.44 } },
    ];
    const TONE_KEY = "redai.skin.tone";

    /* ---------------- 行内变量（最高优先级） ----------------
     * 样式表可能被主题运行时后写入覆盖，行内 + important 不会被压过。
     * 深浅切换由 body[data-ds-dark-theme] 属性驱动，用观察器跟随。
     */
    let INLINE_OK = false;
    const APPLIED = {};   /* token -> true，便于精确还原 */
    let DARK_OBS = null;

    function schemeIsDark() {
      try { return document.body.hasAttribute("data-ds-dark-theme"); } catch (e) { return false; }
    }

    function setVar(name, value) {
      const host = document.body || document.documentElement;
      try { host.style.setProperty(name, value, "important"); APPLIED[name] = true; } catch (e) {}
    }

    function applyInlineVars(skin) {
      if (!skin || !skin.g) { clearInlineVars(); resetTitlebar(); return; }
      const tone = currentTone();
      const dark = schemeIsDark();
      const table = dark ? BASE.dark : BASE.light;
      const alphas = dark ? tone.dark : tone.light;

      /* 一、分层透明：主题把这些变量定义在 body 上，必须写 body */
      for (let i = 0; i < TOKEN_MAP.length; i++) {
        const token = TOKEN_MAP[i][0];
        const key = TOKEN_MAP[i][1];
        const slot = key === "base" ? "veil" : key === "sidebar" ? "sidebar" : "layer";
        setVar(token, rgba(table[key], alphas[slot]));
      }

      /* 二、全局配色：强调色 + 边框色相 + 文字极轻着色（亮度骨架不变） */
      const pal = skin.pal;
      if (pal) {
        const acc = dark ? pal.accent[1] : pal.accent[0];
        const baseText = dark ? pal.label[1] : pal.label[0];
        setVar("--dsw-alias-button-primary-fill", acc);
        setVar("--dsw-alias-button-primary-hover", shade(acc, dark ? 0.18 : -0.14));
        setVar("--dsw-alias-interactive-bg-hover-accent", alphaOf(acc, dark ? 0.18 : 0.12));
        setVar("--dsw-alias-border-l2", alphaOf(acc, dark ? 0.30 : 0.22));
        setVar("--dsw-alias-border-l3", alphaOf(acc, dark ? 0.44 : 0.34));
        setVar("--dsw-alias-label-primary", mix(baseText, acc, 0.07));
      }
      INLINE_OK = true;
      syncTitlebar(skin);
    }

    function clearInlineVars() {
      const hosts = [document.body, document.documentElement];
      const names = Object.keys(APPLIED);
      for (let h = 0; h < hosts.length; h++) {
        if (!hosts[h]) continue;
        for (let i = 0; i < names.length; i++) {
          try { hosts[h].style.removeProperty(names[i]); } catch (e) {}
        }
      }
      for (let i = 0; i < names.length; i++) delete APPLIED[names[i]];
      INLINE_OK = false;
    }

    /* ---------------- 窗口标题栏（右上角控制按钮） ----------------
     * 机制：preload 创建一个隐藏 span 作探针，
     *   background-color: var(--dsw-specific-sidebar-fill)
     *   color:            var(--dsw-alias-label-primary)
     * 并把「计算色」发给主进程 setTitleBarOverlay。
     * 我们直接改探针的行内 color，再抖一次 body 的 style 触发它重发。
     */
    let PROBE = null;

    function findProbe() {
      if (PROBE && PROBE.isConnected) return PROBE;
      try {
        const kids = document.body ? document.body.children : [];
        for (let i = 0; i < kids.length; i++) {
          const el = kids[i];
          if (el.tagName !== "SPAN") continue;
          const st = el.getAttribute("style") || "";
          if (st.indexOf("--dsw-specific-sidebar-fill") >= 0) { PROBE = el; return el; }
        }
      } catch (e) {}
      return null;
    }

    /** 让标题栏图标跟随皮肤强调色 */
    function syncTitlebar(skin) {
      const probe = findProbe();
      if (!probe || !skin || !skin.g || !skin.pal) return;
      const dark = schemeIsDark();
      const acc = dark ? skin.pal.accent[1] : skin.pal.accent[0];
      /* 文字色：深色皮肤用亮一档，浅色皮肤压深保证在浅底上可读 */
      const symbol = dark ? shade(acc, 0.35) : shade(acc, -0.28);
      try {
        probe.style.setProperty("color", symbol, "important");
        probe.style.setProperty("background-color", "transparent", "important");
        /* 触发 preload 的 body style 观察器重发一次 */
        const t = String(Date.now());
        document.body.style.setProperty("--rd-tick", t);
        setTimeout(function () { try { document.body.style.removeProperty("--rd-tick"); } catch (e) {} }, 0);
      } catch (e) {}
    }

    function resetTitlebar() {
      const probe = findProbe();
      if (!probe) return;
      try {
        probe.style.removeProperty("color");
        probe.style.removeProperty("background-color");
        const t = String(Date.now());
        document.body.style.setProperty("--rd-tick", t);
        setTimeout(function () { try { document.body.style.removeProperty("--rd-tick"); } catch (e) {} }, 0);
      } catch (e) {}
    }

    function watchScheme(reapply) {
      try { if (DARK_OBS) DARK_OBS.disconnect(); } catch (e) {}
      try {
        DARK_OBS = new MutationObserver(function () { reapply(); });
        DARK_OBS.observe(document.body, { attributes: true, attributeFilter: ["data-ds-dark-theme"] });
      } catch (e) { DARK_OBS = null; }
    }

    function currentTone() {
      var id = null;
      try { id = localStorage.getItem(TONE_KEY); } catch (e) {}
      for (var i = 0; i < TONES.length; i++) if (TONES[i].id === id) return TONES[i];
      return TONES[1]; /* 默认「标准」 */
    }

    function saveTone(id) {
      try { localStorage.setItem(TONE_KEY, id); } catch (e) {}
      return currentTone();
    }

    /* ---------------- 内置皮肤（渐变，零素材） ---------------- */
    const SKINS = [
      { id: "none", name: "无壁纸", g: null },

      {
        id: "aurora", name: "极光",
        pal: { accent: ["#6366F1", "#818CF8"], label: ["#0f1115", "#f9fafb"] },
        alpha: { light: 0.74, dark: 0.66 },
        g: {
          light:
            "radial-gradient(1100px 780px at 18% 8%, #a5c8ff 0%, transparent 62%)," +
            "radial-gradient(900px 700px at 84% 92%, #f0b8ff 0%, transparent 60%)," +
            "linear-gradient(175deg,#e8f0ff 0%,#dfe4ff 100%)",
          dark:
            "radial-gradient(1100px 780px at 18% 8%, #12233f 0%, transparent 62%)," +
            "radial-gradient(900px 700px at 84% 92%, #2a1733 0%, transparent 60%)," +
            "linear-gradient(175deg,#0b0f18 0%,#0e1220 100%)",
        },
      },

      {
        id: "dawn", name: "晨曦",
        pal: { accent: ["#D97706", "#FBBF24"], label: ["#0f1115", "#f9fafb"] },
        alpha: { light: 0.76, dark: 0.68 },
        g: {
          light:
            "radial-gradient(1000px 720px at 12% 82%, #ffb98f 0%, transparent 64%)," +
            "radial-gradient(900px 680px at 82% 6%, #ffd970 0%, transparent 60%)," +
            "linear-gradient(170deg,#fff6ec 0%,#ffe8d4 100%)",
          dark:
            "radial-gradient(1000px 720px at 12% 82%, #3a2118 0%, transparent 64%)," +
            "radial-gradient(900px 680px at 82% 6%, #3a2f14 0%, transparent 60%)," +
            "linear-gradient(170deg,#12100e 0%,#171310 100%)",
        },
      },

      {
        id: "ink", name: "水墨",
        pal: { accent: ["#475569", "#94A3B8"], label: ["#0f1115", "#f9fafb"] },
        alpha: { light: 0.8, dark: 0.72 },
        g: {
          light:
            "radial-gradient(900px 900px at 78% 12%, #b8c4cc 0%, transparent 66%)," +
            "linear-gradient(180deg,#eef1f3 0%,#dde3e8 100%)",
          dark:
            "radial-gradient(900px 900px at 78% 12%, #22282c 0%, transparent 66%)," +
            "linear-gradient(180deg,#101416 0%,#0a0d0f 100%)",
        },
      },

      {
        id: "grid", name: "网格",
        pal: { accent: ["#0EA5E9", "#38BDF8"], label: ["#0f1115", "#f9fafb"] },
        alpha: { light: 0.78, dark: 0.7 },
        g: {
          light:
            "linear-gradient(rgba(15,17,21,.09) 1px, transparent 1px)," +
            "linear-gradient(90deg, rgba(15,17,21,.09) 1px, transparent 1px)," +
            "linear-gradient(180deg,#f4f7fa,#e4eaf0)",
          dark:
            "linear-gradient(rgba(255,255,255,.05) 1px, transparent 1px)," +
            "linear-gradient(90deg, rgba(255,255,255,.05) 1px, transparent 1px)," +
            "linear-gradient(180deg,#0c0f12,#080a0c)",
        },
      },
    ];

    const GRID_SIZE = "22px 22px";
    const CUSTOM_KEY = "redai.skin.custom";

    /* ---------------- 皮肤包（skin.json） ----------------
     * 结构：
     * { id, name, nameEn?, version?, author?,
     *   wallpaper: { light: "<css 渐变>", dark: "<css 渐变>" },
     *   pal?: { accent: ["#..", "#.."], label: ["#..", "#.."] } }
     * 安全：壁纸只接受渐变/纯色，拒绝 url( 以防导入外部请求。
     */
    function safeBg(v) {
      if (typeof v !== "string" || !v) return null;
      if (v.indexOf("url(") >= 0 || v.indexOf("image-set(") >= 0) return null;
      return /(gradient|#|rgb|hsl|transparent)/i.test(v) ? v : null;
    }

    function validSkin(v) {
      if (!v || typeof v !== "object") return null;
      const id = String(v.id || "").trim();
      const name = String(v.name || "").trim();
      if (!id || !name || !/^[a-zA-Z0-9._-]+$/.test(id)) return null;
      const w = v.wallpaper || {};
      const light = safeBg(w.light);
      const dark = safeBg(w.dark || w.light);
      if (!light || !dark) return null;

      let pal = null;
      if (v.pal && Array.isArray(v.pal.accent) && v.pal.accent.length === 2) {
        const a = v.pal.accent;
        const lb = Array.isArray(v.pal.label) && v.pal.label.length === 2
          ? v.pal.label : ["#0f1115", "#f9fafb"];
        if (parseHex(a[0]) && parseHex(a[1])) pal = { accent: [a[0], a[1]], label: [lb[0], lb[1]] };
      }
      return {
        id: id, name: name, custom: true,
        pal: pal,
        g: { light: light, dark: dark },
        alpha: v.alpha && v.alpha.light ? v.alpha : undefined,
      };
    }

    function loadCustom() {
      try {
        const raw = JSON.parse(localStorage.getItem(CUSTOM_KEY) || "[]");
        if (!Array.isArray(raw)) return [];
        const out = [];
        for (let i = 0; i < raw.length; i++) {
          const sk = validSkin(raw[i]);
          if (sk) out.push(sk);
        }
        return out;
      } catch (e) { return []; }
    }

    function saveCustom(list) {
      try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(list.map(function (x) {
        return { id: x.id, name: x.name, wallpaper: { light: x.g.light, dark: x.g.dark },
                 pal: x.pal, alpha: x.alpha };
      }))); } catch (e) {}
    }

    let CUSTOM = loadCustom();
    function allSkins() { return SKINS.concat(CUSTOM); }

    function byId(id) {
      const all = allSkins();
      for (let i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
      return SKINS[0];
    }

    function ensureStyleTag() {
      let el = document.getElementById(STYLE_ID);
      if (!el) {
        el = document.createElement("style");
        el.id = STYLE_ID;
        (document.head || document.documentElement).appendChild(el);
      }
      return el;
    }

    /** 直接写 CSS 变量：不依赖 theme 服务，带 !important 压过主题快照 */
    function buildVars(skin) {
      const tone = currentTone();
      const li = [], da = [];
      for (let i = 0; i < TOKEN_MAP.length; i++) {
        const token = TOKEN_MAP[i][0];
        const key = TOKEN_MAP[i][1];
        const slot = key === "base" ? "veil" : key === "sidebar" ? "sidebar" : "layer";
        li.push(token + ":" + rgba(BASE.light[key], tone.light[slot]) + "!important");
        da.push(token + ":" + rgba(BASE.dark[key], tone.dark[slot]) + "!important");
      }
      return {
        light: ":root,html{" + li.join(";") + "}",
        dark: "body[data-ds-dark-theme]{" + da.join(";") + "}",
      };
    }

    function cssFor(skin) {
      if (!skin.g) {
        return (
          "html,body{background-color:revert!important;}" +
          "html::before,body::before{content:none!important;}"
        );
      }
      const sizeLight = skin.id === "grid" ? GRID_SIZE + ", " + GRID_SIZE + ", cover" : "cover";
      return (
        /* 壁纸画在固定伪元素上：不依赖任何容器是否透明 */
        "html::before{content:'';position:fixed;inset:0;z-index:-1;pointer-events:none;" +
        "background-image:" + skin.g.light + ";background-size:" + sizeLight + ";background-attachment:fixed;}" +
        "body[data-ds-dark-theme]::before{content:'';position:fixed;inset:0;z-index:-1;pointer-events:none;" +
        "background-image:" + skin.g.dark + ";background-size:" + sizeLight + ";background-attachment:fixed;}" +

        /* 浮层豁免：对话框/模态保持 96%，避免背景内容串进文字 */
        "[role='dialog'],[aria-modal='true']{" +
        "--dsw-alias-bg-base:rgba(255,255,255,.96)!important;" +
        "--dsw-alias-bg-layer-1:rgba(255,255,255,.96)!important;" +
        "--dsw-alias-bg-layer-2:rgba(250,250,251,.96)!important;" +
        "--dsw-alias-bg-layer-3:rgba(255,255,255,.97)!important;}" +
        "body[data-ds-dark-theme] [role='dialog']," +
        "body[data-ds-dark-theme] [aria-modal='true']{" +
        "--dsw-alias-bg-base:rgba(21,21,23,.96)!important;" +
        "--dsw-alias-bg-layer-1:rgba(35,35,36,.96)!important;" +
        "--dsw-alias-bg-layer-2:rgba(44,44,46,.96)!important;" +
        "--dsw-alias-bg-layer-3:rgba(53,54,56,.97)!important;}" +
        /* 毛玻璃：只作用于确定能定位的容器 */
        "div[data-composer-card]{backdrop-filter:blur(12px) saturate(1.06);" +
        "-webkit-backdrop-filter:blur(12px) saturate(1.06);}" +
        "[data-redai-base-pop]{backdrop-filter:blur(14px) saturate(1.06);" +
        "-webkit-backdrop-filter:blur(14px) saturate(1.06);}"
      );
    }

    /* ---------------- 皮肤引擎 ---------------- */
    const engine = (() => {
      let currentId = null;   /* 已提交（写盘）的皮肤 */
      let draftId = null;     /* 试穿中（未写盘）的皮肤 */
      let themeRef = null;

      /** 只渲染，不写盘 */
      function render(id) {
        const skin = byId(id);
        ensureStyleTag().textContent = cssFor(skin);
        applyInlineVars(skin);
        watchScheme(function () { applyInlineVars(byId(draftId || currentId || "aurora")); });
        return skin;
      }

      /** 直接应用并写盘 */
      function set(id) {
        const skin = render(id);
        currentId = skin.id;
        draftId = null;
        try { localStorage.setItem(KEY, skin.id); } catch (e) {}
        console.info(LOG, "skin =", skin.id, "tone =", currentTone().id, skin.g ? "" : "(壁纸关闭)");
        return skin.id;
      }

      /** 试穿：立即预览，不写盘 */
      function preview(id) {
        const skin = render(id);
        draftId = skin.id;
        console.info(LOG, "preview =", skin.id, "(未应用)");
        return skin.id;
      }

      /** 应用：把当前试穿写入磁盘 */
      function commit() {
        if (!draftId) return currentId;
        const id = draftId;
        draftId = null;
        return set(id);
      }

      /** 取消试穿：回到已提交的皮肤 */
      function cancel() {
        draftId = null;
        render(currentId || "aurora");
        return currentId;
      }

      function bind(theme) {
        themeRef = theme;
        const saved = (function () {
          try { return localStorage.getItem(KEY) || "aurora"; } catch (e) { return "aurora"; }
        })();
        set(saved);
      }

      function teardown() {
        try { if (DARK_OBS) { DARK_OBS.disconnect(); DARK_OBS = null; } } catch (e) {}
        clearInlineVars();
        resetTitlebar();
        const el = document.getElementById(STYLE_ID);
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }

      function applyTone(id) {
        saveTone(id);
        set(currentId || "aurora");
        return currentTone().id;
      }

      return {
        bind: bind, set: set, teardown: teardown,
        setTone: applyTone, currentTone: function () { return currentTone().id; },
        preview: preview, commit: commit, cancel: cancel,
        importSkin: function (json) {
          const sk = validSkin(json);
          if (!sk) throw new Error("皮肤包格式不正确（需要 id / name / wallpaper.light）");
          CUSTOM = CUSTOM.filter(function (x) { return x.id !== sk.id; }).concat([sk]);
          saveCustom(CUSTOM);
          return sk.id;
        },
        exportSkin: function (id) {
          const sk = byId(id);
          const o = { id: sk.id, name: sk.name, version: 1,
                      wallpaper: { light: sk.g ? sk.g.light : "", dark: sk.g ? sk.g.dark : "" } };
          if (sk.pal) o.pal = sk.pal;
          return o;
        },
        removeSkin: function (id) {
          CUSTOM = CUSTOM.filter(function (x) { return x.id !== id; });
          saveCustom(CUSTOM);
          if (currentId === id) set("none");
        },
        draft: function () { return draftId; },
        pending: function () { return draftId !== null && draftId !== currentId; },
        tones: function () { return TONES.map(function (x) { return { id: x.id, name: x.name }; }); },
        list: function () {
          return allSkins().map(function (s) {
            return { id: s.id, name: s.name, custom: !!s.custom, bg: s.g ? s.g.light : null, grid: s.id === "grid" };
          });
        },
        current: function () { return currentId; },
      };
    })();


    /* ---------------- 设置行（P2） ---------------- */
    const UI_STYLE_ID = "redai-skin-ui";
    const NS = "RedAi.skin";
    const I18N = {
      zh: { "skin.title": "皮肤", "skin.sub": "壁纸与面板通透度" },
      en: { "skin.title": "Skin", "skin.sub": "Wallpaper and panel translucency" },
    };
    let T = function (k, f) { return f != null ? f : k; };
    function t(k, f) {
      var v = T(k, null);
      return v == null || v === k ? (f != null ? f : k) : v;
    }

    const UI_CSS = [
      ".rs-row{display:flex;align-items:center;gap:14px;padding:12px 0;",
      "border-top:1px solid var(--dsw-alias-border-l1, rgba(127,127,140,.14))}",
      ".rs-main{min-width:0;flex:1}",
      ".rs-title{font-size:var(--dsw-font-xs-13-font-size,13px);font-weight:560;",
      "color:var(--dsw-alias-label-primary,inherit);margin:0 0 3px}",
      ".rs-sub{font-size:var(--dsw-font-xxs-12-font-size,12px);opacity:.6;margin:0}",
      ".rs-right{display:flex;flex-direction:column;gap:8px;align-items:flex-end}",
      ".rs-list{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}",
      ".rs-tones{display:inline-flex;gap:4px;background:var(--dsw-alias-bg-layer-2, rgba(127,127,140,.10));",
      "padding:2px;border-radius:999px}",
      ".rs-tone{appearance:none;font:inherit;font-size:var(--dsw-font-xxxs-11-font-size,11px);",
      "height:20px;padding:0 9px;border:0;border-radius:999px;background:transparent;",
      "color:inherit;opacity:.62;cursor:pointer}",
      ".rs-tone:hover{opacity:.95}",
      ".rs-tone.on{background:var(--dsw-alias-bg-layer-1,#fff);opacity:1;font-weight:560;",
      "box-shadow:var(--dsw-shadow-lv1, 0 1px 2px rgba(20,18,20,.12))}",
      ".rs-tone:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#15151A);outline-offset:1px}",
      ".rs-confirm{display:inline-flex;gap:4px;margin-left:8px}",
      ".rs-pkg{display:inline-flex;gap:4px}",
      ".rs-pkg .rs-cbtn{height:20px}",
      ".rs-cbtn{appearance:none;font:inherit;font-size:var(--dsw-font-xxxs-11-font-size,11px);",
      "height:20px;padding:0 9px;border-radius:999px;cursor:pointer;",
      "border:1px solid var(--dsw-alias-border-l2, rgba(127,127,140,.3));",
      "background:transparent;color:inherit;opacity:.8}",
      ".rs-cbtn:hover{opacity:1}",
      ".rs-cbtn.ok{background:var(--dsw-alias-brand-primary,#15151A);",
      "border-color:var(--dsw-alias-brand-primary,#15151A);color:var(--dsw-alias-bg-layer-1,#fff);opacity:1}",
      ".rs-sw{appearance:none;width:26px;height:26px;padding:0;border:1px solid transparent;",
      "border-radius:8px;cursor:pointer;background:transparent;position:relative}",
      ".rs-sw:hover{border-color:var(--dsw-alias-border-l3, rgba(127,127,140,.45))}",
      ".rs-sw:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#15151A);outline-offset:2px}",
      ".rs-sw.on{border-color:var(--dsw-alias-brand-primary,#15151A)}",
      ".rs-dot{display:block;width:100%;height:100%;border-radius:6px;",
      "box-shadow:inset 0 0 0 1px rgba(20,18,20,.10)}",
      ".rs-dot.none{background:repeating-linear-gradient(45deg,",
      "rgba(127,127,140,.16) 0 3px, transparent 3px 6px)}",
    ].join("");

    function ensureUI() {
      if (document.getElementById(UI_STYLE_ID)) return;
      var s = document.createElement("style");
      s.id = UI_STYLE_ID;
      s.textContent = UI_CSS;
      (document.head || document.documentElement).appendChild(s);
    }

    function SkinRow() {
      React.useEffect(function () { ensureUI(); }, []);
      const st = React.useState(engine.current());
      const committed = st[0];
      const setCommitted = st[1];
      const dp = React.useState(null);
      const draft = dp[0];
      const setDraft = dp[1];
      const ts = React.useState(engine.currentTone());
      const curTone = ts[0];
      const setCurTone = ts[1];

      const items = engine.list();
      const shown = draft || committed;
      const pending = draft !== null && draft !== committed;

      /* 点色卡 = 试穿（不写盘） */
      function pick(id) {
        engine.preview(id);
        setDraft(id);
      }
      function doApply() {
        engine.commit();
        setDraft(null);
        setCommitted(engine.current());
      }
      function doCancel() {
        engine.cancel();
        setDraft(null);
      }

      /* 导入：读 skin.json，校验后加入自定义皮肤 */
      function doImport() {
        var input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";
        input.onchange = function () {
          var f = input.files && input.files[0];
          if (!f) return;
          var r = new FileReader();
          r.onload = function () {
            try {
              var obj = JSON.parse(String(r.result));
              var id = engine.importSkin(obj);
              setDraft(null);
              setCommitted(engine.current());
              engine.preview(id);
              setDraft(id);
              console.info(LOG, "imported", id);
            } catch (e) {
              alert("导入失败：" + (e && e.message ? e.message : e));
            }
          };
          r.readAsText(f);
        };
        input.click();
      }

      /* 导出：当前皮肤 -> skin.json */
      function doExport() {
        var id = draft || committed;
        var obj = engine.exportSkin(id);
        var blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
        var a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "skin." + id + ".json";
        a.click();
        URL.revokeObjectURL(a.href);
      }

      return h("div", { className: "rs-row" },
        h("div", { className: "rs-main" },
          h("div", { className: "rs-title" }, t("skin.title", "皮肤")),
          h("div", { className: "rs-sub" }, t("skin.sub", "壁纸与面板通透度"))
        ),
        h("div", { className: "rs-right" },
        h("div", { className: "rs-list" },
          items.map(function (sk) {
            var isOn = sk.id === shown;
            return h("button", {
              key: sk.id, type: "button",
              className: "rs-sw" + (isOn ? " on" : ""),
              title: sk.name, "aria-label": sk.name,
              "aria-pressed": isOn ? "true" : "false",
              onClick: function () { pick(sk.id); },
            },
              sk.bg
                ? h("span", {
                    className: "rs-dot",
                    style: {
                      backgroundImage: sk.bg,
                      backgroundSize: sk.grid ? "6px 6px, 6px 6px, cover" : "cover",
                    },
                  })
                : h("span", { className: "rs-dot none" })
            );
          })
        ),
        pending
          ? h("div", { className: "rs-confirm" },
              h("button", { type: "button", className: "rs-cbtn", onClick: doCancel }, "取消"),
              h("button", { type: "button", className: "rs-cbtn ok", onClick: doApply }, "应用")
            )
          : null,
        h("div", { className: "rs-pkg" },
          h("button", { type: "button", className: "rs-cbtn", onClick: doImport }, "导入"),
          h("button", { type: "button", className: "rs-cbtn", onClick: doExport }, "导出")
        ),
        h("div", { className: "rs-tones" },
          TONES.map(function (tn) {
            var on = tn.id === curTone;
            return h("button", {
              key: tn.id, type: "button",
              className: "rs-tone" + (on ? " on" : ""),
              "aria-pressed": on ? "true" : "false",
              onClick: function () { setCurTone(engine.setTone(tn.id)); },
            }, tn.name);
          })
        )
        )
      );
    }

    function apply(ctx) {
      try {
        let theme = null;
        try { theme = ctx && typeof ctx.get === "function" ? ctx.get("theme") : null; } catch (e) {}
        if (!theme && ctx) theme = ctx.theme || null;

        if (!theme) {
          console.warn(LOG, "拿不到 theme 服务，壁纸将只铺背景、面板保持不透明");
        }
        engine.bind(theme);

        /* 换肤后如果主题快照被重建，需要重新压一次 */
        try {
          if (ctx && typeof ctx.on === "function") {
            ctx.on("theme/change", function () { engine.set(engine.current() || "aurora"); });
          }
        } catch (e) {}

        /* 卸载回收 */
        try {
          if (ctx && typeof ctx.effect === "function") {
            ctx.effect(function () { return function () { engine.teardown(); }; }, "redai-skin: teardown");
          }
        } catch (e) {}

        /* 临时控制台入口（P2 有设置页后移除） */
        try { window.__redaiSkin = engine; } catch (e) {}

        /* 字典（软获取，拿不到就退中文） */
        try {
          var loc = (ctx && ctx.locale) || (ctx && typeof ctx.get === "function" ? ctx.get("locale") : null);
          if (loc && typeof loc.register === "function") {
            ctx.effect(function () { return loc.register(NS, I18N); }, "redai-skin: dictionaries");
            if (typeof loc.bind === "function") T = loc.bind(NS);
          }
        } catch (e) { console.warn(LOG, "字典注册失败（已降级为中文）", e); }

        /* 设置页「皮肤」行：settings.general.item（官方外观/字号行同款槽位） */
        try {
          if (ctx && ctx.slots && typeof ctx.slots.inject === "function") {
            ctx.slots.inject("settings.general.item", function () {
              return ctx.slots.register({
                name: "settings.general.item",
                id: "skin",
                order: 12,
                locale: NS,
              }, SkinRow);
            });
          }
        } catch (e) { console.warn(LOG, "设置行注册失败", e); }

        /* UI 样式随插件卸载移除 */
        try {
          if (ctx && typeof ctx.effect === "function") {
            ctx.effect(function () {
              return function () {
                var el = document.getElementById(UI_STYLE_ID);
                if (el && el.parentNode) el.parentNode.removeChild(el);
              };
            }, "redai-skin: ui style");
          }
        } catch (e) {}

        console.info(LOG, "loaded, skins:", engine.list().length, "current:", engine.current());
      } catch (e) {
        console.warn(LOG, "apply 失败，插件已降级", e);
      }
    }

    exports.apply = apply;
    exports.inject = ["theme", "slots"];
    return module.exports;
  },
});
