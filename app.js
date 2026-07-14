/* 今晚看什么 · 前端逻辑 */
(() => {
  const $ = (sel) => document.querySelector(sel);

  const form = $("#search-form");
  const input = $("#search-input");
  const searchBtn = $("#search-btn");
  const statusBox = $("#status");
  const statusText = $("#status-text");
  const resultsBox = $("#results");
  const resultsSummary = $("#results-summary");
  const resultsMeta = $("#results-meta");
  const grid = $("#grid");
  const emptyBox = $("#empty");
  const errorBox = $("#error");
  const errorText = $("#error-text");
  const movieModal = $("#movie-modal");
  const modalBody = $("#modal-body");

  const STATUS_STAGES = [
    "AI 正在理解你的需求…",
    "正在检索 OMDb 候选片单…",
    "正在核对 IMDb 评分并筛选…",
  ];

  let stageTimer = null;
  let lastFocused = null;

  function show(el) { el.hidden = false; }
  function hide(el) { el.hidden = true; }

  function setStage(i) {
    statusText.textContent = STATUS_STAGES[Math.min(i, STATUS_STAGES.length - 1)];
  }

  function startStatus() {
    hide(resultsBox); hide(emptyBox); hide(errorBox);
    show(statusBox);
    setStage(0);
    let i = 0;
    stageTimer = setInterval(() => { i += 1; setStage(i); }, 2600);
  }

  function stopStatus() {
    if (stageTimer) { clearInterval(stageTimer); stageTimer = null; }
    hide(statusBox);
  }

  function escapeHTML(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function formatVotes(v) {
    if (v >= 10000) return `${(v / 10000).toFixed(0)} 万票`;
    return `${v} 票`;
  }

  // 海报加载失败时，用片名兜底块替换图片，保证标题始终可见
  window.__posterError = (img) => {
    const fallback = document.createElement("span");
    fallback.className = "poster-fallback";
    fallback.textContent = img.alt.replace(/ 海报$/, "");
    img.replaceWith(fallback);
  };

  let toastTimer = null;
  function toast(text) {
    let el = document.querySelector(".copy-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "copy-toast";
      document.body.appendChild(el);
    }
    el.innerHTML = `<span class="t">已复制</span> ${escapeHTML(text)}`;
    el.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 1600);
  }

  async function copyTitle(title, btn) {
    try {
      await navigator.clipboard.writeText(title);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = title;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    toast(title);
    if (btn) {
      btn.classList.add("copied");
      const label = btn.querySelector(".copy-label");
      if (label) label.textContent = "已复制";
      setTimeout(() => {
        btn.classList.remove("copied");
        if (label) label.textContent = "复制片名";
      }, 1600);
    }
  }

  function render(data) {
    if (!data.movies || data.movies.length === 0) {
      show(emptyBox);
      return;
    }
    resultsSummary.innerHTML =
      `${escapeHTML(data.summary)} · 共 <strong>${data.count}</strong> 部 ≥ <strong>${data.minRating.toFixed(1)}</strong> 分`;
    resultsMeta.textContent = data.relaxed
      ? "候选不足，已自动放宽评分门槛"
      : "按 IMDb 评分排序";
    grid.innerHTML = "";
    data.movies.forEach((m, idx) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "card";
      card.style.animationDelay = `${Math.min(idx * 55, 660)}ms`;
      card.setAttribute("aria-label", `${m.title}，评分 ${m.rating}，查看详情`);
      const posterHTML = m.poster
        ? `<img class="poster" src="${escapeHTML(m.poster)}" alt="${escapeHTML(m.title)} 海报" loading="lazy" onerror="__posterError(this)" />`
        : "";
      card.innerHTML = `
        <span class="poster-wrap">
          ${posterHTML}
          ${m.poster ? "" : `<span class="poster-fallback">${escapeHTML(m.title)}</span>`}
          <span class="rating-badge"><span class="star">★</span>${m.rating.toFixed(1)}</span>
        </span>
        <span class="card-info">
          <span class="card-title" title="点击复制片名">${escapeHTML(m.title)}</span>
          <span class="card-meta">${escapeHTML(m.year)} · ${escapeHTML((m.genre || "").split(",")[0] || m.type || "")}</span>
        </span>`;
      card.addEventListener("click", () => openMovie(m, card));
      const titleEl = card.querySelector(".card-title");
      titleEl.addEventListener("click", (e) => {
        e.stopPropagation();
        copyTitle(m.title, null);
      });
      grid.appendChild(card);
    });
    show(resultsBox);
    resultsBox.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function watchLinksMarkup(m) {
    const q = encodeURIComponent(`${m.title} ${String(m.year).slice(0, 4)}`.trim());
    const qTitle = encodeURIComponent(m.title);
    const links = [
      { name: "豆瓣", desc: "条目 · 评分 · 影评", url: `https://search.douban.com/movie/subject_search?search_text=${q}` },
      { name: "JustWatch", desc: "正版流媒体平台", url: `https://www.justwatch.com/us/search?q=${qTitle}` },
      { name: "资源搜索", desc: "磁力链搜索引擎", url: `https://btdig.com/search?q=${q}` },
    ];
    return `
      <div class="watch-section">
        <div class="watch-head">
          <span class="watch-title">去哪看</span>
          <span class="watch-note">搜索跳转，请在目标站自行核实</span>
        </div>
        <div class="link-cards">
          ${links.map((l) => `
            <a class="link-card" href="${l.url}" target="_blank" rel="noreferrer noopener">
              <span>
                <strong>${l.name}</strong>
                <small>${l.desc}</small>
              </span>
              <span class="link-arrow" aria-hidden="true">↗</span>
            </a>`).join("")}
        </div>
      </div>`;
  }

  function openMovie(m, sourceEl) {
    lastFocused = sourceEl || document.activeElement;
    const facts = [
      ["导演", m.director],
      ["主演", m.actors],
      ["类型", m.genre],
      ["片长", m.runtime],
      ["地区", m.country],
      ["语言", m.language],
      ["分级", m.rated],
      ["奖项", m.awards],
    ].filter(([, v]) => v);
    modalBody.innerHTML = `
      ${m.posterLarge
        ? `<img class="modal-poster" src="${escapeHTML(m.posterLarge)}" alt="${escapeHTML(m.title)} 海报" onerror="__posterError(this)" />`
        : `<span class="poster-fallback" style="position:static;aspect-ratio:2/3;border-radius:6px;">${escapeHTML(m.title)}</span>`}
      <div>
        <div class="modal-title-row">
          <h3 class="modal-title" id="modal-title">${escapeHTML(m.title)}</h3>
          <button type="button" class="copy-btn" id="copy-title-btn" title="复制片名">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>
            <span class="copy-label">复制片名</span>
          </button>
        </div>
        <div class="modal-sub">
          <span>${escapeHTML(m.year)}</span>
          ${m.runtime ? `<span>${escapeHTML(m.runtime)}</span>` : ""}
          ${m.rated ? `<span>${escapeHTML(m.rated)}</span>` : ""}
        </div>
        <div class="modal-rating">
          <span class="score">★ ${m.rating.toFixed(1)}</span>
          <span class="of">/ 10</span>
          <span class="votes">${formatVotes(m.votes)}</span>
        </div>
        ${m.plot ? `<p class="modal-plot">${escapeHTML(m.plot)}</p>` : ""}
        <div class="modal-facts">
          ${facts.map(([k, v]) => `<div class="fact"><span class="k">${k}</span><span class="v">${escapeHTML(v)}</span></div>`).join("")}
        </div>
        <a class="modal-imdb" href="${escapeHTML(m.imdbURL)}" target="_blank" rel="noopener">在 IMDb 查看 ↗</a>
        ${watchLinksMarkup(m)}
      </div>`;
    modalBody.querySelector("#copy-title-btn").addEventListener("click", (e) => {
      copyTitle(m.title, e.currentTarget);
    });
    openModal(movieModal);
  }

  function openModal(modal) {
    modal.hidden = false;
    document.body.classList.add("modal-open");
    const closeBtn = modal.querySelector(".modal-close");
    if (closeBtn) closeBtn.focus();
  }

  function closeModal(modal) {
    modal.hidden = true;
    document.body.classList.remove("modal-open");
    if (lastFocused && document.contains(lastFocused)) lastFocused.focus();
  }

  function closeTopModal() {
    const open = [...document.querySelectorAll(".modal")].find((m) => !m.hidden);
    if (open) closeModal(open);
  }

  document.addEventListener("click", (e) => {
    const closer = e.target.closest("[data-close]");
    if (closer) closeModal(closer.closest(".modal"));
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeTopModal();
  });

  $("#reward-btn").addEventListener("click", () => {
    lastFocused = $("#reward-btn");
    openModal($("#reward-modal"));
  });
  $("#follow-btn").addEventListener("click", () => {
    lastFocused = $("#follow-btn");
    openModal($("#follow-modal"));
  });

  async function search(query) {
    searchBtn.disabled = true;
    startStatus();
    try {
      const res = await fetch("/api/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const data = await res.json().catch(() => null);
      stopStatus();
      if (!res.ok || !data || data.ok === false) {
        errorText.textContent = (data && data.error) || "服务暂时不可用，请稍后再试。";
        show(errorBox);
        return;
      }
      render(data);
    } catch {
      stopStatus();
      errorText.textContent = "网络异常，请检查连接后再试。";
      show(errorBox);
    } finally {
      searchBtn.disabled = false;
      if (document.activeElement === searchBtn) input.focus();
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const query = input.value.trim();
    if (!query) { input.focus(); return; }
    search(query);
  });

  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      input.value = chip.textContent.trim();
      form.requestSubmit();
    });
  });
})();
