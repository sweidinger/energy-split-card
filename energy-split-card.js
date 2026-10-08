/**
 * Energy Split Card for Home Assistant
 * https://github.com/sweidinger/energy-split-card
 *
 * Stacked bar chart and totals table for any set of long-term statistics
 * (gas, electricity, water, heat ...), following the period of the native
 * `energy-date-selection` card – styled like the Energy dashboard, but with
 * sources you choose yourself. Optional total statistic adds an "untracked"
 * segment, optional cost statistic distributes real costs per source.
 *
 * MIT License
 */

const CARD_VERSION = "1.1.0";

const DEFAULT_COLORS = [
  "var(--energy-gas-color, #8e021b)",
  "#ff9800",
  "#03a9f4",
  "#4caf50",
  "#9c27b0",
  "#795548",
];
const UNTRACKED_COLOR = "var(--state-unavailable-color, #9e9e9e)";

const T = {
  de: {
    untracked: "Nicht zugeordnet",
    total: "Gesamt",
    source: "Quelle",
    energy: "Energie",
    cost: "Kosten",
    share: "Anteil",
    sums: "Summen",
    noData: "Keine Daten in diesem Zeitraum",
    noSelector:
      "Keine Datumsauswahl gefunden – zeige heute. Füge eine Karte vom Typ energy-date-selection hinzu.",
    loading: "Lade …",
  },
  en: {
    untracked: "Untracked",
    total: "Total",
    source: "Source",
    energy: "Energy",
    cost: "Cost",
    share: "Share",
    sums: "Totals",
    noData: "No data for this period",
    noSelector:
      "No date selection found – showing today. Add an energy-date-selection card.",
    loading: "Loading …",
  },
};

class EnergySplitCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._data = null;
    this._start = null;
    this._end = null;
    this._period = "hour";
    this._unsub = null;
    this._pollTimer = null;
    this._width = 0;
    this._fetchSeq = 0;
    this._fallback = false;
    this._hidden = new Set();
  }

  static getStubConfig() {
    return {
      title: "Gas",
      series: [{ entity: "sensor.gas_heizung", name: "Heizung" }],
    };
  }

  setConfig(config) {
    if (!config || !Array.isArray(config.series) || config.series.length === 0) {
      throw new Error("Bitte mindestens einen Eintrag unter `series` angeben (entity, name).");
    }
    for (const s of config.series) {
      if (!s.entity) throw new Error("Jeder Eintrag unter `series` braucht `entity`.");
    }
    if (config.collection_key && !String(config.collection_key).startsWith("energy_")) {
      throw new Error("`collection_key` muss mit `energy_` beginnen.");
    }
    const display = config.display || (config.show_table === false ? "chart" : "both");
    if (!["both", "chart", "table"].includes(display)) {
      throw new Error("`display` muss both, chart oder table sein.");
    }
    this._config = { chart_height: 300, show_share: false, ...config, display };
    this._series = config.series.map((s, i) => ({
      entity: s.entity,
      name: s.name || s.entity,
      color: s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length],
    }));
    this._data = null;
    this.shadowRoot.innerHTML = "";
    if (this._hass && this._start) this._fetch();
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._connect();
    const price = this._config?.price_entity ? hass.states[this._config.price_entity]?.state : null;
    if (price !== this._lastPrice) {
      this._lastPrice = price;
      this._render();
    }
  }

  connectedCallback() {
    if (this._hass && !this._unsub) this._connect();
    if (!this._ro) {
      this._ro = new ResizeObserver((entries) => {
        const w = Math.floor(entries[0].contentRect.width);
        if (w && w !== this._width) {
          this._width = w;
          this._renderChart();
        }
      });
    }
    requestAnimationFrame(() => this._observe());
  }

  _observe() {
    const box = this.shadowRoot.querySelector(".chart");
    if (box && this._ro) this._ro.observe(box);
  }

  disconnectedCallback() {
    if (this._unsub) {
      try {
        this._unsub();
      } catch (e) {
        /* ignore */
      }
      this._unsub = null;
    }
    clearTimeout(this._pollTimer);
    this._ro?.disconnect();
  }

  getCardSize() {
    return this._config?.display === "table" ? 3 : 7;
  }

  getGridOptions() {
    return { columns: 12, rows: "auto", min_columns: 6 };
  }

  // ---- period source -------------------------------------------------------

  _collections() {
    const conn = this._hass.connection;
    const keys = [];
    if (this._config.collection_key) keys.push("_" + this._config.collection_key);
    if (this._hass.panelUrl) keys.push("_energy_" + this._hass.panelUrl);
    keys.push("_energy");
    return keys.map((k) => conn[k]).filter(Boolean);
  }

  _connect(attempt = 0) {
    if (!this._hass || this._unsub || !this._config) return;
    const found = this._collections()[0];
    if (found) {
      this._fallback = false;
      this._unsub = found.subscribe((d) => this._setPeriod(d.start, d.end));
      return;
    }
    if (attempt < 50) {
      this._pollTimer = setTimeout(() => this._connect(attempt + 1), 200);
      return;
    }
    this._fallback = true;
    const s = new Date();
    s.setHours(0, 0, 0, 0);
    const e = new Date(s);
    e.setDate(e.getDate() + 1);
    e.setMilliseconds(-1);
    this._setPeriod(s, e);
  }

  _setPeriod(start, end) {
    if (!start) return;
    const s = new Date(start);
    const e = end ? new Date(end) : new Date(s.getTime() + 86400000 - 1);
    this._start = s;
    this._end = e;
    const days = (e - s) / 86400000;
    this._period = days > 35 ? "month" : days > 2 ? "day" : "hour";
    this._fetch();
  }

  // ---- data ---------------------------------------------------------------

  async _fetch() {
    if (!this._hass || !this._start) return;
    const seq = ++this._fetchSeq;
    const ids = this._series.map((s) => s.entity);
    if (this._config.total_entity) ids.push(this._config.total_entity);
    if (this._config.cost_entity) ids.push(this._config.cost_entity);
    let res = {};
    try {
      res = await this._hass.callWS({
        type: "recorder/statistics_during_period",
        start_time: this._start.toISOString(),
        end_time: new Date(this._end.getTime() + 1).toISOString(),
        statistic_ids: ids,
        period: this._period,
        types: ["change"],
      });
    } catch (err) {
      console.error("energy-split-card: statistics query failed", err);
    }
    if (seq !== this._fetchSeq) return;
    this._data = this._process(res || {});
    this._render();
  }

  _buckets() {
    const out = [];
    const d = new Date(this._start);
    const end = this._end.getTime();
    for (let i = 0; i < 400 && d.getTime() <= end; i++) {
      out.push(d.getTime());
      if (this._period === "hour") d.setHours(d.getHours() + 1);
      else if (this._period === "day") d.setDate(d.getDate() + 1);
      else d.setMonth(d.getMonth() + 1);
    }
    return out;
  }

  _process(res) {
    const toMap = (id) => {
      const m = new Map();
      for (const row of res[id] || []) {
        const t = typeof row.start === "number" ? row.start : new Date(row.start).getTime();
        if (row.change != null) m.set(t, row.change);
      }
      return m;
    };
    const seriesMaps = this._series.map((s) => toMap(s.entity));
    const totalMap = this._config.total_entity ? toMap(this._config.total_entity) : null;
    const costMap = this._config.cost_entity ? toMap(this._config.cost_entity) : null;

    const set = new Set(this._buckets());
    for (const m of [...seriesMaps, ...(totalMap ? [totalMap] : [])]) for (const t of m.keys()) set.add(t);
    const buckets = [...set].sort((a, b) => a - b);

    const rows = buckets.map((t) => {
      const values = seriesMaps.map((m) => Math.max(0, m.get(t) || 0));
      const sum = values.reduce((a, b) => a + b, 0);
      const total = totalMap ? Math.max(0, totalMap.get(t) || 0) : sum;
      const untracked = totalMap ? Math.max(0, total - sum) : 0;
      const cost = costMap ? Math.max(0, costMap.get(t) || 0) : null;
      return { t, values, untracked, total: Math.max(total, sum), cost };
    });
    const totals = this._series.map((_, i) => rows.reduce((a, r) => a + r.values[i], 0));
    const untrackedTotal = rows.reduce((a, r) => a + r.untracked, 0);

    // Real costs: distribute each bucket's cost proportionally to its energy.
    let costs = null;
    if (costMap) {
      costs = this._series.map(() => 0);
      let untrackedCost = 0;
      for (const r of rows) {
        if (!(r.cost > 0) || !(r.total > 0)) continue;
        const perUnit = r.cost / r.total;
        r.values.forEach((v, i) => (costs[i] += v * perUnit));
        untrackedCost += r.untracked * perUnit;
      }
      costs.untracked = untrackedCost;
    }
    const hasData = rows.some((r) => r.total > 0);
    return { rows, totals, untrackedTotal, costs, hasData };
  }

  // ---- formatting ---------------------------------------------------------

  get _lang() {
    return this._hass?.language || this._hass?.locale?.language || "en";
  }

  get _t() {
    return T[this._lang.slice(0, 2)] || T.en;
  }

  _num(v, min = 0, max = 2) {
    return new Intl.NumberFormat(this._lang, { minimumFractionDigits: min, maximumFractionDigits: max }).format(v);
  }

  _money(v) {
    const cur = this._hass?.config?.currency || "EUR";
    return new Intl.NumberFormat(this._lang, { style: "currency", currency: cur }).format(v);
  }

  _fmt(t, opts) {
    const tf = this._hass?.locale?.time_format;
    if (opts.hour && (tf === "24" || tf === "12")) opts = { ...opts, hour12: tf === "12" };
    try {
      return new Intl.DateTimeFormat(this._lang, { ...opts, timeZone: this._hass?.config?.time_zone }).format(new Date(t));
    } catch (e) {
      return new Intl.DateTimeFormat(this._lang, opts).format(new Date(t));
    }
  }

  _longLabel(t) {
    if (this._period === "hour") {
      const end = t + 3600000;
      return `${this._fmt(t, { weekday: "short", day: "numeric", month: "short" })}, ${this._fmt(t, {
        hour: "2-digit",
        minute: "2-digit",
      })} – ${this._fmt(end, { hour: "2-digit", minute: "2-digit" })}`;
    }
    if (this._period === "day") return this._fmt(t, { weekday: "short", day: "numeric", month: "long", year: "numeric" });
    return this._fmt(t, { month: "long", year: "numeric" });
  }

  // Axis labels like the Energy dashboard: a bold label at the start of each
  // larger unit (day / month / year), plain labels in between.
  _axisLabel(t) {
    const d = new Date(t);
    if (this._period === "hour") {
      if (d.getHours() === 0) return { text: this._fmt(t, { day: "numeric", month: "short" }), bold: true };
      return { text: this._fmt(t, { hour: "numeric", minute: "2-digit" }), bold: false };
    }
    if (this._period === "day") {
      if (d.getDate() === 1) return { text: this._fmt(t, { month: "short" }), bold: true };
      return { text: this._fmt(t, { day: "numeric", month: "short" }), bold: false };
    }
    if (d.getMonth() === 0) return { text: this._fmt(t, { year: "numeric" }), bold: true };
    return { text: this._fmt(t, { month: "short" }), bold: false };
  }

  _labelStep(n, iw) {
    const sample = this._axisLabel(this._data.rows[Math.min(1, n - 1)].t).text.length;
    const maxLabels = Math.max(2, Math.floor(iw / (sample * 7 + 24)));
    const steps =
      this._period === "hour" ? [1, 2, 3, 4, 6, 12, 24] : this._period === "day" ? [1, 2, 7, 14] : [1, 2, 3, 6, 12];
    return steps.find((s) => Math.ceil(n / s) <= maxLabels) || steps[steps.length - 1];
  }

  _isLabelSlot(t, idx, step) {
    if (step === 1) return true;
    const d = new Date(t);
    if (this._period === "hour") return d.getHours() % step === 0;
    if (this._period === "day") return idx % step === 0;
    return d.getMonth() % step === 0;
  }

  _unit() {
    if (this._config.unit) return this._config.unit;
    const ids = [...this._series.map((s) => s.entity), this._config.total_entity].filter(Boolean);
    for (const id of ids) {
      const u = this._hass?.states[id]?.attributes?.unit_of_measurement;
      if (u) return u;
    }
    return "";
  }

  _price() {
    if (!this._config.price_entity) return null;
    const v = parseFloat(this._hass?.states[this._config.price_entity]?.state);
    return Number.isFinite(v) ? v : null;
  }

  // ---- rendering ----------------------------------------------------------

  _ensureDom() {
    const root = this.shadowRoot;
    if (root.querySelector("ha-card")) return;
    const disp = this._config.display;
    root.innerHTML = `
      <style>
        :host { display: block; }
        ha-card { height: 100%; box-sizing: border-box; display: flex; flex-direction: column; }
        .header { display: flex; align-items: center; justify-content: space-between; gap: 8px;
                  padding: 16px 16px 0; min-height: 40px; }
        .title { font-size: var(--ha-card-header-font-size, 24px); font-weight: 400; line-height: 1.3;
                 color: var(--ha-card-header-color, var(--primary-text-color)); letter-spacing: -0.012em; }
        .badge { border: 1px solid var(--divider-color, rgba(127,127,127,.3)); border-radius: 8px;
                 padding: 4px 10px; font-size: 14px; font-weight: 500; white-space: nowrap;
                 color: var(--primary-text-color); font-variant-numeric: tabular-nums; }
        .badge:empty { display: none; }
        .content { padding: 8px 16px 16px; }
        .chart { position: relative; width: 100%; min-height: 60px; }
        .msg { color: var(--secondary-text-color); font-size: 0.9em; padding: 8px 0; }
        svg { display: block; overflow: visible; }
        .tick { fill: var(--secondary-text-color); font-size: 12px; font-variant-numeric: tabular-nums; }
        .tick.bold { fill: var(--primary-text-color); font-weight: 700; }
        .grid { stroke: var(--divider-color, rgba(127,127,127,.2)); stroke-width: 1; }
        .hit { fill: transparent; }
        .hit:hover { fill: var(--primary-text-color); fill-opacity: .05; }
        .tip { position: absolute; pointer-events: none; background: var(--card-background-color, #fff);
               color: var(--primary-text-color); border: 1px solid var(--divider-color, #ccc);
               border-radius: 8px; padding: 8px 10px; font-size: 13px; line-height: 1.6;
               box-shadow: 0 2px 10px rgba(0,0,0,.25); white-space: nowrap; z-index: 2;
               font-variant-numeric: tabular-nums; }
        .tip b { display: block; margin-bottom: 2px; font-weight: 500; }
        .tdot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; vertical-align: -1px; }
        table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
        th { text-align: left; font-weight: 500; font-size: 14px; color: var(--primary-text-color);
             padding: 0 8px 12px; border-bottom: 1px solid var(--divider-color, #ddd); }
        td { padding: 14px 8px; border-bottom: 1px solid var(--divider-color, #eee); color: var(--primary-text-color); font-size: 14px; }
        th.n, td.n { text-align: right; }
        td.sw { width: 52px; padding-right: 0; }
        .swatch { display: block; width: 44px; height: 22px; border-radius: 6px; box-sizing: border-box; border: 1.5px solid; }
        tr.total td { font-weight: 500; border-bottom: 0; }
        tr.off td { opacity: .4; }
        tr.row { cursor: pointer; }
      </style>
      <ha-card>
        <div class="header"><span class="title"></span><span class="badge"></span></div>
        <div class="content">
          ${disp !== "table" ? `<div class="chart"><div class="tip" hidden></div></div>` : ""}
          ${disp !== "chart" ? `<div class="table"></div>` : ""}
        </div>
      </ha-card>`;
    this._observe();
  }

  _render() {
    if (!this._config) return;
    this._ensureDom();
    const root = this.shadowRoot;
    const t = this._t;
    const disp = this._config.display;
    root.querySelector(".title").textContent =
      this._config.title ?? (disp === "table" ? t.sums : "");
    const badge = root.querySelector(".badge");
    const d = this._data;
    if (disp !== "table" && d && d.hasData) {
      const tot = this._visibleTotal();
      badge.textContent = `${this._num(tot, 0, 2)} ${this._unit()}`;
    } else badge.textContent = "";
    this._renderChart();
    this._renderTable();
  }

  _visibleTotal() {
    const d = this._data;
    return d.totals.reduce((a, v, i) => a + (this._hidden.has(i) ? 0 : v), 0) + (this._hidden.has("u") ? 0 : d.untrackedTotal);
  }

  _parts(r) {
    const parts = r.values.map((v, i) => ({ v: this._hidden.has(i) ? 0 : v, c: this._series[i].color }));
    if (this._config.total_entity && !this._hidden.has("u")) parts.push({ v: r.untracked, c: UNTRACKED_COLOR });
    return parts;
  }

  _renderChart() {
    const box = this.shadowRoot.querySelector(".chart");
    if (!box) return;
    const tip = box.querySelector(".tip");
    box.querySelectorAll("svg, .msg").forEach((n) => n.remove());
    const t = this._t;
    const d = this._data;
    if (!d) {
      box.insertAdjacentHTML("afterbegin", `<div class="msg">${t.loading}</div>`);
      return;
    }
    if (this._fallback) box.insertAdjacentHTML("afterbegin", `<div class="msg">${t.noSelector}</div>`);
    if (!d.hasData) {
      box.insertAdjacentHTML("beforeend", `<div class="msg">${t.noData}</div>`);
      return;
    }
    const W = this._width || box.clientWidth || 600;
    const H = this._config.chart_height;
    const unit = this._unit();
    const rows = d.rows;
    const maxV = Math.max(...rows.map((r) => this._parts(r).reduce((a, p) => a + p.v, 0)), 0);
    const { max, step, decimals } = niceScale(maxV);
    const yLabelW = Math.max(...[0, max].map((v) => this._num(v, decimals, decimals).length)) * 7 + 10;
    const m = { l: Math.max(36, yLabelW), r: 8, t: 22, b: 26 };
    const iw = Math.max(10, W - m.l - m.r);
    const ih = H - m.t - m.b;
    const y = (v) => m.t + ih - (v / max) * ih;
    const n = rows.length;
    const slot = iw / n;
    const bw = Math.max(1, Math.min(slot * 0.7, 56));

    let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">`;
    for (let v = 0; v <= max + step / 1000; v += step) {
      const yy = y(v).toFixed(1);
      s += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}"/>`;
      s += `<text class="tick" x="${m.l - 8}" y="${yy}" text-anchor="end" dominant-baseline="middle">${this._num(v, decimals, decimals)}</text>`;
    }
    s += `<text class="tick" x="${m.l}" y="${m.t - 10}" text-anchor="start">${esc(unit)}</text>`;

    const lstep = this._labelStep(n, iw);
    rows.forEach((r, idx) => {
      const x0 = m.l + slot * idx;
      if (this._isLabelSlot(r.t, idx, lstep)) {
        const lab = this._axisLabel(r.t);
        s += `<line class="grid" x1="${x0.toFixed(1)}" x2="${x0.toFixed(1)}" y1="${m.t}" y2="${m.t + ih}"/>`;
        s += `<text class="tick${lab.bold ? " bold" : ""}" x="${x0.toFixed(1)}" y="${H - 6}" text-anchor="${idx === 0 ? "start" : "middle"}">${esc(lab.text)}</text>`;
      }
    });
    s += `<line class="grid" x1="${(m.l + iw).toFixed(1)}" x2="${(m.l + iw).toFixed(1)}" y1="${m.t}" y2="${m.t + ih}"/>`;

    rows.forEach((r, idx) => {
      const x = m.l + slot * idx + (slot - bw) / 2;
      let acc = 0;
      const visible = this._parts(r).filter((p) => p.v > 0);
      visible.forEach((p, k) => {
        const y1 = y(acc + p.v);
        const h = Math.max(0, y(acc) - y1);
        const top = k === visible.length - 1;
        const style = `fill:${p.c};fill-opacity:.5;stroke:${p.c};stroke-width:1.5`;
        s += top && h > 4
          ? `<path d="${roundTop(x, y1, bw, h, Math.min(4, bw / 4))}" style="${style}"/>`
          : `<rect x="${x.toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" style="${style}"/>`;
        acc += p.v;
      });
      s += `<rect class="hit" data-i="${idx}" x="${(m.l + slot * idx).toFixed(1)}" y="${m.t}" width="${slot.toFixed(1)}" height="${ih}"/>`;
    });
    s += `</svg>`;
    box.insertAdjacentHTML("afterbegin", s);

    const svg = box.querySelector("svg");
    svg.addEventListener("mousemove", (ev) => {
      const hit = ev.target.closest?.(".hit");
      if (!hit) {
        tip.hidden = true;
        return;
      }
      const r = rows[+hit.dataset.i];
      let html = `<b>${esc(this._longLabel(r.t))}</b>`;
      this._series.forEach((se, i) => {
        if (this._hidden.has(i)) return;
        html += `<div><span class="tdot" style="background:${se.color}"></span>${esc(se.name)}: ${this._num(r.values[i])} ${esc(unit)}</div>`;
      });
      if (this._config.total_entity && !this._hidden.has("u") && r.untracked > 0)
        html += `<div><span class="tdot" style="background:${UNTRACKED_COLOR}"></span>${t.untracked}: ${this._num(r.untracked)} ${esc(unit)}</div>`;
      tip.innerHTML = html;
      tip.hidden = false;
      const rect = box.getBoundingClientRect();
      let left = ev.clientX - rect.left + 14;
      if (left + tip.offsetWidth > rect.width) left = ev.clientX - rect.left - tip.offsetWidth - 14;
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = `${Math.max(0, ev.clientY - rect.top - tip.offsetHeight - 10)}px`;
    });
    svg.addEventListener("mouseleave", () => (tip.hidden = true));
  }

  _renderTable() {
    const el = this.shadowRoot.querySelector(".table");
    if (!el) return;
    const d = this._data;
    const t = this._t;
    if (!d || !d.hasData) {
      el.innerHTML = this._config.display === "table" && d ? `<div class="msg">${t.noData}</div>` : "";
      return;
    }
    const unit = this._unit();
    const price = this._price();
    const items = this._series.map((s, i) => ({ key: i, name: s.name, color: s.color, v: d.totals[i], c: d.costs ? d.costs[i] : null }));
    if (this._config.total_entity)
      items.push({ key: "u", name: t.untracked, color: UNTRACKED_COLOR, v: d.untrackedTotal, c: d.costs ? d.costs.untracked : null });
    const costOf = (it) => (it.c != null ? it.c : price != null ? it.v * price : null);
    const costCol = d.costs != null || price != null;
    const shareCol = this._config.show_share;
    const active = items.filter((it) => !this._hidden.has(it.key));
    const sum = active.reduce((a, it) => a + it.v, 0);
    const sumCost = active.reduce((a, it) => a + (costOf(it) || 0), 0);

    let h = `<table><thead><tr><th></th><th>${t.source}</th><th class="n">${t.energy}</th>${
      costCol ? `<th class="n">${t.cost}</th>` : ""
    }${shareCol ? `<th class="n">${t.share}</th>` : ""}</tr></thead><tbody>`;
    for (const it of items) {
      h += `<tr class="row${this._hidden.has(it.key) ? " off" : ""}" data-k="${it.key}">
        <td class="sw"><span class="swatch" style="background:${it.color};border-color:${it.color};background-color:color-mix(in srgb, ${it.color} 50%, transparent)"></span></td>
        <td>${esc(it.name)}</td>
        <td class="n">${this._num(it.v)} ${esc(unit)}</td>
        ${costCol ? `<td class="n">${this._money(costOf(it) || 0)}</td>` : ""}
        ${shareCol ? `<td class="n">${sum > 0 && !this._hidden.has(it.key) ? this._num((it.v / sum) * 100, 0, 1) : 0} %</td>` : ""}
      </tr>`;
    }
    h += `<tr class="total"><td></td><td>${esc(this._config.total_label || t.total)}</td><td class="n">${this._num(sum)} ${esc(unit)}</td>${
      costCol ? `<td class="n">${this._money(sumCost)}</td>` : ""
    }${shareCol ? `<td></td>` : ""}</tr></tbody></table>`;
    el.innerHTML = h;
    el.querySelectorAll("tr.row").forEach((tr) =>
      tr.addEventListener("click", () => {
        const k = tr.dataset.k === "u" ? "u" : +tr.dataset.k;
        if (this._hidden.has(k)) this._hidden.delete(k);
        else this._hidden.add(k);
        this._render();
      })
    );
  }
}

function niceScale(maxV) {
  if (!(maxV > 0)) return { max: 1, step: 0.25, decimals: 2 };
  const raw = maxV / 7;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const f = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  const step = f * mag;
  const max = Math.ceil(maxV / step - 1e-9) * step;
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9) + (f === 2.5 ? 1 : 0));
  return { max: max || step, step, decimals };
}

function roundTop(x, y, w, h, r) {
  return `M${x.toFixed(1)},${(y + h).toFixed(1)}V${(y + r).toFixed(1)}Q${x.toFixed(1)},${y.toFixed(1)} ${(x + r).toFixed(1)},${y.toFixed(1)}H${(x + w - r).toFixed(1)}Q${(x + w).toFixed(1)},${y.toFixed(1)} ${(x + w).toFixed(1)},${(y + r).toFixed(1)}V${(y + h).toFixed(1)}Z`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

if (!customElements.get("energy-split-card")) {
  customElements.define("energy-split-card", EnergySplitCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "energy-split-card",
    name: "Energy Split Card",
    description: "Gestapelte Verbrauchsbalken und Summentabelle für frei wählbare Statistiken, gesteuert über energy-date-selection.",
    documentationURL: "https://github.com/sweidinger/energy-split-card",
  });
  console.info(`%c ENERGY-SPLIT-CARD %c ${CARD_VERSION} `, "background:#8e021b;color:#fff", "background:#444;color:#fff");
}
