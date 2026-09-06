import { srgbToHex, type ParamSpec } from './schema.ts';
import type { ParamStore } from './store.ts';

/**
 * Hand-rolled panel — no dependency. Every control is generated from a
 * ParamSpec, so adding a parameter is one comment in the shader and nothing
 * else anywhere.
 */

export interface Builtins {
  seed: number;
  spp: number;
  quality: number;
  paused: boolean;
}

export interface Preset {
  name: string;
  values: Record<string, unknown>;
}

export interface GuiHooks {
  builtins: Builtins;
  presets: Preset[];
  pieces: { id: string; title: string }[];
  currentPiece: string;
  /** True when the piece has simulation passes, which can be re-seeded. */
  hasSim: boolean;
  onPiece(id: string): void;
  onResetSim(): void;
  onChange(): void;
  onBuiltin(): void;
  onCapture(name: string): Promise<string>;
  onLoadPreset(name: string): void;
  onCopyUrl(): Promise<string>;
  onReset(): void;
}

const CSS = `
.pa-gui{position:fixed;top:12px;right:12px;width:294px;max-height:calc(100vh - 24px);
  overflow:auto;background:rgba(16,15,19,.9);backdrop-filter:blur(8px);
  border:1px solid rgba(255,255,255,.09);border-radius:8px;
  font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#cfcbd6;
  padding:10px;user-select:none;z-index:10}
.pa-gui[hidden]{display:none}
.pa-sec{margin:0 0 6px;padding:0 0 6px;border-bottom:1px solid rgba(255,255,255,.07)}
.pa-sec:last-of-type{border-bottom:0}
.pa-h{color:rgba(255,255,255,.34);letter-spacing:.08em;text-transform:uppercase;
  font-size:9px;margin:2px 0 6px}
.pa-row{display:flex;align-items:center;gap:6px;margin:3px 0;min-height:19px}
.pa-lab{flex:0 0 84px;color:#a49fae;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pa-ctl{flex:1;display:flex;align-items:center;gap:4px;min-width:0}
.pa-val{flex:0 0 46px;text-align:right;color:#efeaf5;font-variant-numeric:tabular-nums}
.pa-gui input[type=range]{flex:1;min-width:0;height:3px;appearance:none;background:#3a3543;
  border-radius:2px;outline:0}
.pa-gui input[type=range]::-webkit-slider-thumb{appearance:none;width:11px;height:11px;
  border-radius:50%;background:#c9a6ff;cursor:ew-resize}
.pa-gui input[type=range]::-moz-range-thumb{width:11px;height:11px;border:0;border-radius:50%;
  background:#c9a6ff;cursor:ew-resize}
.pa-gui input[type=number],.pa-gui select,.pa-gui input[type=text]{flex:1;min-width:0;
  background:#221f28;border:1px solid rgba(255,255,255,.1);border-radius:4px;
  color:#efeaf5;font:inherit;padding:2px 5px}
.pa-gui input[type=color]{flex:1;min-width:0;height:19px;padding:0;border:1px solid
  rgba(255,255,255,.12);border-radius:4px;background:#221f28;cursor:pointer}
.pa-gui button{background:#2c2734;border:1px solid rgba(255,255,255,.1);border-radius:4px;
  color:#d9d3e2;font:inherit;padding:3px 7px;cursor:pointer}
.pa-gui button:hover{background:#39324a;color:#fff}
.pa-foot{display:flex;gap:5px;margin-top:8px}
.pa-foot button{flex:1}
.pa-note{margin-top:6px;color:#8f8a99;min-height:14px;word-break:break-word}
.pa-status{margin-top:4px;color:#6f6a7a;font-variant-numeric:tabular-nums}
.pa-vecrow{display:flex;gap:4px;align-items:center}
`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function fmt(v: number, step: number): string {
  const d = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));
  return v.toFixed(d);
}

export class Gui {
  readonly root: HTMLDivElement;
  private body: HTMLDivElement;
  private note: HTMLDivElement;
  private status: HTMLDivElement;
  private store: ParamStore;
  private hooks: GuiHooks;

  constructor(store: ParamStore, hooks: GuiHooks) {
    this.store = store;
    this.hooks = hooks;

    if (!document.getElementById('pa-gui-css')) {
      const style = el('style');
      style.id = 'pa-gui-css';
      style.textContent = CSS;
      document.head.append(style);
    }

    this.root = el('div', 'pa-gui');
    this.body = el('div');
    this.note = el('div', 'pa-note');
    this.status = el('div', 'pa-status');

    const foot = el('div', 'pa-foot');
    const capture = el('button', undefined, 'capture');
    capture.title = 'save current values as a named preset in meta.json';
    capture.onclick = async () => {
      const name = prompt('preset name');
      if (!name) return;
      this.note.textContent = await hooks.onCapture(name);
    };
    const link = el('button', undefined, 'copy url');
    link.onclick = async () => {
      this.note.textContent = await hooks.onCopyUrl();
    };
    const reset = el('button', undefined, 'reset');
    reset.onclick = () => {
      hooks.onReset();
      this.rebuild(this.store);
    };
    foot.append(capture, link, reset);

    this.root.append(this.body, foot, this.status, this.note);
    document.body.append(this.root);
    this.rebuild(store);
  }

  /** Live readout — sample count while a paused frame refines. */
  setStatus(text: string): void {
    if (this.status.textContent !== text) this.status.textContent = text;
  }

  get visible(): boolean {
    return !this.root.hidden;
  }
  toggle(): void {
    this.root.hidden = !this.root.hidden;
  }

  rebuild(store: ParamStore): void {
    this.store = store;
    this.body.replaceChildren();
    this.body.append(this.builtinSection());
    if (this.hooks.presets.length > 0) this.body.append(this.presetSection());
    if (store.specs.length > 0) {
      this.body.append(this.paramSection(store));
    } else {
      const s = el('div', 'pa-sec');
      s.append(el('div', 'pa-h', 'parameters'));
      s.append(el('div', 'pa-note', 'none declared — add // @param to a uniform'));
      this.body.append(s);
    }
  }

  private row(label: string): { row: HTMLDivElement; ctl: HTMLDivElement } {
    const row = el('div', 'pa-row');
    row.append(el('div', 'pa-lab', label));
    const ctl = el('div', 'pa-ctl');
    row.append(ctl);
    return { row, ctl };
  }

  private builtinSection(): HTMLElement {
    const b = this.hooks.builtins;
    const sec = el('div', 'pa-sec');
    sec.append(el('div', 'pa-h', 'render'));

    if (this.hooks.pieces.length > 1) {
      const { row, ctl } = this.row('piece');
      const sel = el('select');
      for (const p of this.hooks.pieces) {
        const o = el('option', undefined, `${p.id} ${p.title}`);
        o.value = p.id;
        sel.append(o);
      }
      sel.value = this.hooks.currentPiece;
      sel.onchange = () => this.hooks.onPiece(sel.value);
      ctl.append(sel);
      sec.append(row);
    }

    {
      const { row, ctl } = this.row('seed');
      const input = el('input');
      input.type = 'number';
      input.value = String(b.seed);
      input.oninput = () => {
        b.seed = Math.round(Number(input.value) || 0);
        this.hooks.onBuiltin();
      };
      const dice = el('button', undefined, '↻');
      dice.title = 'new seed';
      dice.onclick = () => {
        b.seed = Math.floor(Math.random() * 1e6);
        input.value = String(b.seed);
        this.hooks.onBuiltin();
      };
      ctl.append(input, dice);
      sec.append(row);
    }

    {
      const { row, ctl } = this.row('spp');
      const range = el('input');
      range.type = 'range';
      range.min = '1';
      range.max = '32';
      range.step = '1';
      range.value = String(b.spp);
      const out = el('div', 'pa-val', String(b.spp));
      range.oninput = () => {
        b.spp = Number(range.value);
        out.textContent = range.value;
        this.hooks.onBuiltin();
      };
      ctl.append(range);
      row.append(out);
      sec.append(row);
    }

    if (this.hooks.hasSim) {
      const { row, ctl } = this.row('simulation');
      const btn = el('button', undefined, 'reset & re-seed');
      btn.onclick = () => this.hooks.onResetSim();
      ctl.append(btn);
      sec.append(row);
    }

    {
      const { row, ctl } = this.row('final quality');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = b.quality > 0;
      cb.onchange = () => {
        b.quality = cb.checked ? 1 : 0;
        this.hooks.onBuiltin();
      };
      ctl.append(cb);
      sec.append(row);
    }

    return sec;
  }

  private presetSection(): HTMLElement {
    const sec = el('div', 'pa-sec');
    sec.append(el('div', 'pa-h', 'presets'));
    const { row, ctl } = this.row('load');
    const sel = el('select');
    sel.append(el('option', undefined, '—'));
    for (const p of this.hooks.presets) {
      const o = el('option', undefined, p.name);
      o.value = p.name;
      sel.append(o);
    }
    sel.onchange = () => {
      if (!sel.value || sel.value === '—') return;
      this.hooks.onLoadPreset(sel.value);
      this.rebuild(this.store);
    };
    ctl.append(sel);
    sec.append(row);
    return sec;
  }

  private paramSection(store: ParamStore): HTMLElement {
    const sec = el('div', 'pa-sec');
    sec.append(el('div', 'pa-h', 'parameters'));
    for (const spec of store.specs) sec.append(this.control(store, spec));
    return sec;
  }

  private control(store: ParamStore, spec: ParamSpec): HTMLElement {
    const { row, ctl } = this.row(spec.label);
    const changed = () => this.hooks.onChange();

    switch (spec.kind) {
      case 'float':
      case 'int': {
        const range = el('input');
        range.type = 'range';
        range.min = String(spec.min);
        range.max = String(spec.max);
        range.step = String(spec.step);
        range.value = String(store.get(spec.name));
        const out = el('div', 'pa-val', fmt(store.get(spec.name) as number, spec.step));
        range.oninput = () => {
          store.set(spec.name, Number(range.value));
          out.textContent = fmt(store.get(spec.name) as number, spec.step);
          changed();
        };
        ctl.append(range);
        row.append(out);
        break;
      }
      case 'vec': {
        const wrap = el('div', 'pa-vecrow');
        wrap.style.flexDirection = 'column';
        wrap.style.alignItems = 'stretch';
        wrap.style.gap = '2px';
        wrap.style.flex = '1';
        for (let i = 0; i < spec.dims; i++) {
          const line = el('div', 'pa-vecrow');
          const range = el('input');
          range.type = 'range';
          range.min = String(spec.min);
          range.max = String(spec.max);
          range.step = String(spec.step);
          range.value = String((store.get(spec.name) as number[])[i]);
          const out = el('div', 'pa-val', fmt((store.get(spec.name) as number[])[i], spec.step));
          range.oninput = () => {
            const next = [...(store.get(spec.name) as number[])];
            next[i] = Number(range.value);
            store.set(spec.name, next);
            out.textContent = fmt((store.get(spec.name) as number[])[i], spec.step);
            changed();
          };
          line.append(range, out);
          wrap.append(line);
        }
        ctl.append(wrap);
        break;
      }
      case 'color': {
        const input = el('input');
        input.type = 'color';
        input.value = `#${srgbToHex(store.get(spec.name) as number[])}`;
        input.oninput = () => {
          const h = input.value.slice(1);
          store.set(spec.name, [
            parseInt(h.slice(0, 2), 16) / 255,
            parseInt(h.slice(2, 4), 16) / 255,
            parseInt(h.slice(4, 6), 16) / 255,
          ]);
          changed();
        };
        ctl.append(input);
        break;
      }
      case 'toggle': {
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = store.get(spec.name) as boolean;
        cb.onchange = () => {
          store.set(spec.name, cb.checked);
          changed();
        };
        ctl.append(cb);
        break;
      }
      case 'enum': {
        const sel = el('select');
        for (const o of spec.options) {
          const opt = el('option', undefined, o.label);
          opt.value = String(o.value);
          sel.append(opt);
        }
        sel.value = String(store.get(spec.name));
        sel.onchange = () => {
          store.set(spec.name, Number(sel.value));
          changed();
        };
        ctl.append(sel);
        break;
      }
    }
    return row;
  }
}
