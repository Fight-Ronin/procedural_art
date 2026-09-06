/**
 * The parameter declaration is the single source of truth for the GUI, the URL
 * state, presets and (later) CLI flags. These checks pin the syntax, the
 * sRGB -> linear colour conversion, and the hot-reload adopt() semantics.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  ParamParseError,
  parseBuffers,
  parseParams,
  srgbToLinear1,
  type ParamSpec,
} from '../visualization/params/schema.ts';
import { ParamStore } from '../visualization/params/store.ts';
import { check, section, throwsWith } from './harness.ts';
import { ROOT as root } from './paths.ts';

section('parameters');
const throws = (name: string, fn: () => unknown) => throwsWith(name, ParamParseError, fn);

const FIXTURE = `
uniform float uWarp;   // @param 0 .. 3 = 1.2 "domain warp"
uniform int   uOct;    // @param 1 .. 8 = 5 step 1 "octaves"
uniform vec2  uShift;  // @param -1 .. 1 = 0.25,-0.5 "shift"
uniform vec3  uTint;   // @color = #ff8844 "tint"
uniform bool  uLines;  // @toggle = true "isolines"
uniform int   uMode;   // @enum 0:soft 1:hard 2:ink "edge mode"
uniform float uPlain;  // @param 0 .. 1 = 0.5
float notAUniform;     // @param 0 .. 1 = 0.5 "ignored"
`;

const specs = parseParams(FIXTURE);
const by = (n: string) => specs.find((s) => s.name === n) as ParamSpec;

check('parses every kind', specs.length === 7, `${specs.length} specs`);
check('ignores non-uniform lines', !specs.some((s) => s.name === 'notAUniform'));
check('int gets step 1', (by('uOct') as { step: number }).step === 1);
check('float gets a derived step',
  Math.abs((by('uWarp') as { step: number }).step - 3 / 200) < 1e-9);
check('vec2 keeps both defaults',
  JSON.stringify((by('uShift') as { def: number[] }).def) === '[0.25,-0.5]');
check('enum options parse',
  JSON.stringify((by('uMode') as { options: { label: string }[] }).options.map((o) => o.label)) ===
    '["soft","hard","ink"]');
check('label falls back to the uniform name', (by('uPlain') as { label: string }).label === 'plain');
check('label is de-camel-cased', (by('uWarp') as { label: string }).label === 'domain warp');

throws('rejects a viz built-in', () => parseParams('uniform int uSeed; // @param 0 .. 9 = 0'));
throws('rejects a duplicate', () =>
  parseParams('uniform float uA; // @param 0 .. 1 = 0\nuniform float uA; // @param 0 .. 1 = 0'));
throws('rejects @color on a non-vec3', () => parseParams('uniform float uC; // @color = #ffffff'));
throws('rejects a bad range', () => parseParams('uniform float uA; // @param 2 .. 1 = 0'));
throws('rejects an unknown annotation', () => parseParams('uniform float uA; // @slider 0 .. 1'));
throws('rejects a wrong-arity vector default', () =>
  parseParams('uniform vec3 uV; // @param 0 .. 1 = 0.1,0.2'));

// --- colour: declared in sRGB, uploaded in linear ---------------------------
// This is the one place a human-typed colour crosses into the linear pipeline.
// Getting it wrong makes every piece read washed out, with no obvious cause.
const tint = (by('uTint') as { def: number[] }).def;
check('hex decodes to sRGB 0..1',
  Math.abs(tint[0] - 1) < 1e-6 && Math.abs(tint[1] - 0x88 / 255) < 1e-6,
  JSON.stringify(tint));
check('mid grey converts to linear ~0.2159',
  Math.abs(srgbToLinear1(0.5) - 0.21404) < 1e-3,
  String(srgbToLinear1(0.5)));

// --- store ------------------------------------------------------------------
const store = new ParamStore(specs);
check('defaults populate', store.get('uWarp') === 1.2 && store.get('uLines') === true);

store.set('uWarp', 99);
check('values clamp to range', store.get('uWarp') === 3, String(store.get('uWarp')));
store.set('uOct', 3.7);
check('int values round', store.get('uOct') === 4, String(store.get('uOct')));

store.set('uWarp', 2.5);
store.set('uShift', [-0.75, 0.25]);
store.set('uLines', false);
store.set('uMode', 2);
const hash = store.toHash();
const restored = new ParamStore(specs);
restored.fromHash(hash);
check('url round-trip preserves every kind',
  restored.get('uWarp') === 2.5 &&
    JSON.stringify(restored.get('uShift')) === '[-0.75,0.25]' &&
    restored.get('uLines') === false &&
    restored.get('uMode') === 2,
  hash);

const snapRoundTrip = new ParamStore(specs);
snapRoundTrip.load(store.snapshot());
check('preset snapshot round-trips colour as hex',
  JSON.stringify(snapRoundTrip.get('uTint')) === JSON.stringify(store.get('uTint')),
  JSON.stringify(store.snapshot().uTint));

// --- adopt(): the hot-reload contract ---------------------------------------
const edited = parseParams(`
uniform float uWarp;   // @param 0 .. 1 = 0.5 "domain warp"
uniform int   uOct;    // @param 1 .. 8 = 5 step 1 "octaves"
uniform float uNew;    // @param 0 .. 1 = 0.3 "new one"
`);
const live = new ParamStore(specs);
live.set('uWarp', 2.5);
live.set('uOct', 7);
live.adopt(edited);
check('adopt resets a value that left its range', live.get('uWarp') === 0.5,
  String(live.get('uWarp')));
check('adopt keeps a value still in range', live.get('uOct') === 7, String(live.get('uOct')));
check('adopt adds new parameters at their default', live.get('uNew') === 0.3);
check('adopt drops removed parameters', live.get('uShift') === undefined);

// --- the real artwork -------------------------------------------------------
const real = parseParams(readFileSync(path.join(root, 'artwork/001-drift/main.frag'), 'utf8'));
check('001 declares parameters', real.length >= 10, `${real.length} parameters`);
check('001 declares its palette as colours',
  real.filter((s) => s.kind === 'color').length === 3);

const real2 = parseParams(readFileSync(path.join(root, 'artwork/002-vitreous/main.frag'), 'utf8'));
check('002 declares parameters', real2.length >= 18, `${real2.length} parameters`);
check('002 declares an enum for the environment',
  real2.some((s) => s.kind === 'enum' && s.name === 'uEnvMode'));
check('002 declares an int with an explicit step',
  real2.some((s) => s.kind === 'int' && s.name === 'uBounces'));

// --- buffer bindings ---------------------------------------------------------
const bufFixture = `
uniform sampler2D uField;   // @buffer a "chemical field"
uniform sampler2D uOther;   // @buffer b
uniform float uX;           // @param 0 .. 1 = 0.5
`;
const binds = parseBuffers(bufFixture);
check('parses buffer bindings', binds.length === 2, JSON.stringify(binds));
check('buffer binding keeps its pass id', binds[0].pass === 'a' && binds[1].pass === 'b');
check('buffer label falls back to the uniform name', binds[1].label === 'other');
check('parseParams ignores samplers', parseParams(bufFixture).length === 1);
throws('rejects a duplicate buffer binding', () =>
  parseBuffers('uniform sampler2D uA; // @buffer a\nuniform sampler2D uA; // @buffer b'));
throws('rejects a malformed @buffer', () => parseBuffers('uniform sampler2D uA; // @buffer'));
throws('rejects a misspelled sampler annotation', () =>
  parseBuffers('uniform sampler2D uA; // @bufer a'));
throws('rejects @param on a sampler', () =>
  parseBuffers('uniform sampler2D uA; // @param 0 .. 1 = 0'));

const img003 = readFileSync(path.join(root, 'artwork/003-coalesce/main.frag'), 'utf8');
const buf003 = readFileSync(path.join(root, 'artwork/003-coalesce/buffer-a.frag'), 'utf8');
check('003 image pass reads the field', parseBuffers(img003)[0]?.pass === 'a');
check('003 simulation pass reads itself (feedback)', parseBuffers(buf003)[0]?.pass === 'a');
check('003 declares parameters across both passes',
  parseParams(img003).length >= 8 && parseParams(buf003).length >= 6,
  `${parseParams(img003).length} image + ${parseParams(buf003).length} simulation`);
