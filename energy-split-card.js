/**
 * Energy Split Card for Home Assistant
 * https://github.com/sweidinger/energy-split-card
 *
 * Stacked bar chart for any set of long-term statistics (gas, electricity,
 * water, heat ...), following the period of the native `energy-date-selection`
 * card – just like the graphs on the Energy dashboard, but with sources you
 * choose yourself. Optional total statistic adds an "untracked" segment.
 *
 * MIT License
 */

const CARD_VERSION = "1.0.1";

const DEFAULT_COLORS = [
  "var(--energy-gas-color, #8e021b)",
  "#ff9800",
  "#03a9f4",
  "#4caf50",
  "#9c27b0",
  "#795548",
];
const UNTRACKED_COLOR = "var(--secondary-text-color, #9e9e9e)";

const T = {
  de: {
    untracked: "Nicht zugeordnet",
    total: "Gesamt",
    source: "Quelle",
    energy: "Verbrauch",
    cost: "Kosten",
    share: "Anteil",
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
    this._config = {
      chart_height: 240,
      show_table: true,
      ...config,
    };
    this._series = config.series.map((s, i) => ({
      entity: s.entity,
      name: s.name || s.entity,
      color: s.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length],
    }));
    this._data = null;
    if (this._hass) this._fetch();
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._connect();
    // Price changes only affect the table.
    const price = this._config?.price_entity ? hass.states[this._config.price_entity]?.state : null;
    if (price !== this._lastPrice) {
      this._lastPrice = price;
      this._render();
    }
  }

  get _t() {
    const lang = this._lang.slice(0, 2);
    return T[lang] || T.en;
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
    requestAnimationFrame(() => {
      const box = this.shadowRoot.querySelector(".chart");
      if (box) this._ro.observe(box);
    });
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
    return 7;
  }

  getGridOptions() {
    return { columns: 12, rows: "auto", min_columns: 6 };
  }

  // ---- period source -------------------------------------------------------

  _collectionKeys() {
    const conn = this._hass.connection;
    const keys = [];
    if (this._config.collection_key) keys.push("_" + this._config.collection_key);
    if (this._hass.panelUrl) keys.push("_energy_" + this._hass.panelUrl);
    keys.push("_energy");
    return keys.map((k) => conn[k]).filter(Boolean);
  }

  _connect(attempt = 0) {
    if (!this._hass || this._unsub) return;
    const found = this._collectionKeys()[0];
    if (found) {
      this._fallback = false;
      this._unsub = found.subscribe((d) => this._setPeriod(d.start, d.end));
      return;
    }
    if (attempt < 50) {
      this._pollTimer = setTimeout(() => this._connect(attempt + 1), 200);
      return;
    }
    // No selector on the page: show today.
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
    let e = end ? new Date(end) : new Date(s.getTime() + 86400000 - 1);
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
    this._loading = true;
    this._render();
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
    this._loading = false;
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
        if (row.change != null) m.set(t, Math.max(0, row.change));
      }
      return m;
    };
    const seriesMaps = this._series.map((s) => toMap(s.entity));
    const totalMap = this._config.total_entity ? toMap(this._config.total_entity) : null;

    const set = new Set(this._buckets());
    for (const m of [...seriesMaps, ...(totalMap ? [totalMap] : [])]) for (const t of m.keys()) set.add(t);
    const buckets = [...set].sort((a, b) => a - b);

    const rows = buckets.map((t) => {
      const values = seriesMaps.map((m) => m.get(t) || 0);
      const sum = values.reduce((a, b) => a + b, 0);
      let untracked = 0;
      if (totalMap) untracked = Math.max(0, (totalMap.get(t) || 0) - sum);
      return { t, values, untracked, stack: sum + untracked };
    });
    const totals = this._series.map((_, i) => rows.reduce((a, r) => a + r.values[i], 0));
    const untrackedTotal = rows.reduce((a, r) => a + r.untracked, 0);
    const hasData = rows.some((r) => r.stack > 0);
    return { rows, totals, untrackedTotal, hasData };
  }

  // ---- formatting ---------------------------------------------------------

  get _lang() {
    return this._hass?.language || this._hass?.locale?.language || "en";
  }

  _hour12() {
    const tf = this._hass?.locale?.time_format;
    if (tf === "24") return false;
    if (tf === "12") return true;
    return undefined;
  }

  _num(v, digits = 2) {
    return new Intl.NumberFormat(this._lang, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(v);
  }

  _money(v) {
    const cur = this._hass?.config?.currency || "EUR";
    return new Intl.NumberFormat(this._lang, { style: "currency", currency: cur }).format(v);
  }

  _tz() {
    return this._hass?.config?.time_zone;
  }

  _label(t, long = false) {
    const opts =
      this._period === "hour"
        ? long
          ? { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }
          : { hour: "2-digit", minute: "2-digit" }
        : this._period === "day"
        ? long
          ? { weekday: "short", day: "numeric", month: "short", year: "numeric" }
          : { day: "numeric", month: "numeric" }
        : long
        ? { month: "long", year: "numeric" }
        : { month: "short" };
    if (this._period === "hour" && this._hour12() !== undefined) opts.hour12 = this._hour12();
    try {
      return new Intl.DateTimeFormat(this._lang, { ...opts, timeZone: this._tz() }).format(new Date(t));
    } catch (e) {
      return new Intl.DateTimeFormat(this._lang, opts).format(new Date(t));
    }
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

  _render() {
    if (!this._config) return;
    const root = this.shadowRoot;
    if (!root.querySelector("ha-card")) {
      root.innerHTML = `
        <style>
          :host { display: block; }
          ha-card { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
          .head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
          .title { font-size: 1.15em; font-weight: 500; color: var(--primary-text-color); }
          .sum { color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
          .chart { position: relative; width: 100%; min-height: 60px; }
          .msg { color: var(--secondary-text-color); font-size: 0.9em; padding: 8px 0; }
          svg { display: block; overflow: visible; }
          .tick { fill: var(--secondary-text-color); font-size: 11px; font-variant-numeric: tabular-nums; }
          .grid { stroke: var(--divider-color, rgba(127,127,127,.25)); stroke-width: 1; }
          .hit { fill: transparent; cursor: default; }
          .hit:hover { fill: var(--primary-text-color); fill-opacity: .06; }
          .tip { position: absolute; pointer-events: none; background: var(--card-background-color, #fff);
                 color: var(--primary-text-color); border: 1px solid var(--divider-color, #ccc);
                 border-radius: 8px; padding: 8px 10px; font-size: 12px; line-height: 1.5;
                 box-shadow: 0 2px 8px rgba(0,0,0,.18); white-space: nowrap; z-index: 2;
                 font-variant-numeric: tabular-nums; }
          .tip b { display: block; margin-bottom: 2px; }
          .dot { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
          table { width: 100%; border-collapse: collapse; font-size: 0.95em; font-variant-numeric: tabular-nums; }
          th { text-align: left; font-weight: 500; color: var(--secondary-text-color); font-size: 0.85em; padding: 4px 6px; border-bottom: 1px solid var(--divider-color, #ddd); }
          td { padding: 6px; border-bottom: 1px solid var(--divider-color, #eee); color: var(--primary-text-color); }
          th.n, td.n { text-align: right; }
          tr.total td { font-weight: 600; border-bottom: 0; }
          tr.off td { opacity: .45; }
          tr.row { cursor: pointer; }
        </style>
        <ha-card>
          <div class="head"><span class="title"></span><span class="sum"></span></div>
          <div class="chart"><div class="tip" hidden></div></div>
          <div class="table"></div>
        </ha-card>`;
      this._hidden = new Set();
    }
    root.querySelector(".title").textContent = this._config.title || "";
    const t = this._t;
    const d = this._data;
    const sumEl = root.querySelector(".sum");
    if (d && d.hasData) {
      const tot = d.totals.reduce((a, b) => a + b, 0) + d.untrackedTotal;
      sumEl.textContent = `${t.total}: ${this._num(tot)} ${this._unit()}`;
    } else sumEl.textContent = "";
    this._renderChart();
    this._renderTable();
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
    const W = this._width || box.clientWidth || 400;
    const H = this._config.chart_height;
    const m = { l: 44, r: 6, t: 8, b: 22 };
    const iw = Math.max(10, W - m.l - m.r);
    const ih = H - m.t - m.b;
    const hidden = this._hidden;
    const rows = d.rows;
    const stackOf = (r) =>
      r.values.reduce((a, v, i) => a + (hidden.has(i) ? 0 : v), 0) + (hidden.has("u") ? 0 : r.untracked);
    const maxV = Math.max(...rows.map(stackOf), 0);
    const { max, step } = niceScale(maxV);
    const y = (v) => m.t + ih - (v / max) * ih;
    const n = rows.length;
    const slot = iw / n;
    const bw = Math.max(1, Math.min(slot * 0.72, 48));
    const unit = this._unit();

    let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">`;
    for (let v = 0; v <= max + 1e-9; v += step) {
      const yy = y(v).toFixed(1);
      s += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}"/>`;
      s += `<text class="tick" x="${m.l - 6}" y="${yy}" text-anchor="end" dominant-baseline="middle">${this._num(v, step < 1 ? 1 : 0)}</text>`;
    }
    s += `<text class="tick" x="${m.l - 6}" y="${m.t - 2}" text-anchor="end">${unit}</text>`;
    const maxChars = Math.max(...rows.map((r) => this._label(r.t).length), 1);
    const perLabel = maxChars * 6.5 + 12;
    const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(iw / perLabel))));
    rows.forEach((r, idx) => {
      const cx = m.l + slot * idx + slot / 2;
      const x = (cx - bw / 2).toFixed(1);
      let acc = 0;
      const parts = r.values.map((v, i) => ({ v: hidden.has(i) ? 0 : v, c: this._series[i].color }));
      if (this._config.total_entity && !hidden.has("u")) parts.push({ v: r.untracked, c: UNTRACKED_COLOR });
      const visible = parts.filter((p) => p.v > 0);
      visible.forEach((p, k) => {
        const y1 = y(acc + p.v);
        const h = Math.max(0, y(acc) - y1);
        const top = k === visible.length - 1;
        s += top && h > 3
          ? `<path d="${roundTop(+x, y1, bw, h, Math.min(3, bw / 3))}" fill="${p.c}"/>`
          : `<rect x="${x}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${p.c}"/>`;
        acc += p.v;
      });
      s += `<rect class="hit" data-i="${idx}" x="${(m.l + slot * idx).toFixed(1)}" y="${m.t}" width="${slot.toFixed(1)}" height="${ih}"/>`;
      if (idx % labelEvery === 0)
        s += `<text class="tick" x="${cx.toFixed(1)}" y="${H - 6}" text-anchor="middle">${this._label(r.t)}</text>`;
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
      let html = `<b>${this._label(r.t, true)}</b>`;
      this._series.forEach((se, i) => {
        if (hidden.has(i)) return;
        html += `<div><span class="dot" style="background:${se.color}"></span>${esc(se.name)}: ${this._num(r.values[i])} ${unit}</div>`;
      });
      if (this._config.total_entity && !hidden.has("u") && r.untracked > 0)
        html += `<div><span class="dot" style="background:${UNTRACKED_COLOR}"></span>${t.untracked}: ${this._num(r.untracked)} ${unit}</div>`;
      tip.innerHTML = html;
      tip.hidden = false;
      const rect = box.getBoundingClientRect();
      let left = ev.clientX - rect.left + 12;
      if (left + tip.offsetWidth > rect.width) left = ev.clientX - rect.left - tip.offsetWidth - 12;
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = `${Math.max(0, ev.clientY - rect.top - tip.offsetHeight - 8)}px`;
    });
    svg.addEventListener("mouseleave", () => (tip.hidden = true));
  }

  _renderTable() {
    const el = this.shadowRoot.querySelector(".table");
    if (!el) return;
    const d = this._data;
    if (!this._config.show_table || !d || !d.hasData) {
      el.innerHTML = "";
      return;
    }
    const t = this._t;
    const unit = this._unit();
    const price = this._price();
    const items = this._series.map((s, i) => ({ key: i, name: s.name, color: s.color, v: d.totals[i] }));
    if (this._config.total_entity) items.push({ key: "u", name: t.untracked, color: UNTRACKED_COLOR, v: d.untrackedTotal });
    const sum = items.reduce((a, it) => a + it.v, 0);
    const costCol = price != null;
    let h = `<table><thead><tr><th>${t.source}</th><th class="n">${t.energy}</th>${costCol ? `<th class="n">${t.cost}</th>` : ""}<th class="n">${t.share}</th></tr></thead><tbody>`;
    for (const it of items) {
      h += `<tr class="row${this._hidden.has(it.key) ? " off" : ""}" data-k="${it.key}"><td><span class="dot" style="background:${it.color}"></span>${esc(it.name)}</td><td class="n">${this._num(it.v)} ${unit}</td>${costCol ? `<td class="n">${this._money(it.v * price)}</td>` : ""}<td class="n">${sum > 0 ? this._num((it.v / sum) * 100, 1) : 0} %</td></tr>`;
    }
    h += `<tr class="total"><td>${t.total}</td><td class="n">${this._num(sum)} ${unit}</td>${costCol ? `<td class="n">${this._money(sum * price)}</td>` : ""}<td class="n"></td></tr></tbody></table>`;
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
  if (!(maxV > 0)) return { max: 1, step: 0.25 };
  const raw = maxV / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  return { max: Math.ceil(maxV / step) * step, step };
}

function roundTop(x, y, w, h, r) {
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
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
    description: "Gestapelte Verbrauchsbalken für frei wählbare Statistiken, gesteuert über energy-date-selection.",
    documentationURL: "https://github.com/sweidinger/energy-split-card",
  });
  console.info(`%c ENERGY-SPLIT-CARD %c ${CARD_VERSION} `, "background:#8e021b;color:#fff", "background:#444;color:#fff");
}
